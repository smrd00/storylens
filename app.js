console.log("StoryLens running");

// ============================================================
//  TOAST NOTIFICATIONS
// ============================================================
function showToast(msg) {
  let toast = document.getElementById("slToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "slToast";
    toast.style.cssText = [
      "position:fixed","bottom:56px","left:50%","transform:translateX(-50%) translateY(12px)",
      "background:rgba(44,32,21,0.88)","color:#fff","padding:10px 22px",
      "border-radius:50px","font-size:0.9em","z-index:99999","pointer-events:none",
      "opacity:0","transition:opacity 0.3s,transform 0.3s","white-space:nowrap",
      "font-family:Georgia,serif","letter-spacing:0.02em"
    ].join(";");
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = "1";
  toast.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(function() {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-50%) translateY(12px)";
  }, 2200);
}

// PDF worker
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

// ============================================================
//  STATE
// ============================================================
let currentPDF    = null;
let currentPage   = 1;
let totalPages    = 0;
let rendition     = null;
let currentBookName = "";
let currentBookType = "";  // "pdf" | "epub"
let detectedCharacters = {};
let characterColors    = {};
let currentFont = 'default'; // 'default' | 'literata' | 'merriweather' | 'lora' | 'atkinson' | 'opendyslexic'
let characterStyles    = {}; // per-character style: "underline" | "solid" | "ombre"
let characterIcons     = {}; // per-character icon: "none" | "star" | "dot" | "triangle" | "diamond"

const DYSLEXIC_FONT_CSS = `
  @font-face {
    font-family: 'OpenDyslexic';
    src: url('fonts/OpenDyslexic/OpenDyslexic-Regular.otf') format('opentype');
  }
  * { font-family: 'OpenDyslexic', sans-serif !important; }
`;

// ============================================================
//  INDEXED DB  — Library Storage
// ============================================================
const DB_NAME    = "StoryLensLibrary";
const DB_VERSION = 1;
const STORE_NAME = "books";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("name", "name", { unique: false });
      }
    };
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

async function saveBookToDB(name, type, arrayBuffer) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    // Check if book with same name already exists; if so, update
    const idx   = store.index("name");
    const getReq = idx.get(name);
    getReq.onsuccess = function() {
      const existing = getReq.result;
      if (existing) {
        // update data + timestamp
        const putReq = store.put({ ...existing, data: arrayBuffer, lastRead: Date.now() });
        putReq.onsuccess = () => resolve(existing.id);
        putReq.onerror   = e => reject(e.target.error);
      } else {
        const addReq = store.add({ name, type, data: arrayBuffer, lastRead: Date.now() });
        addReq.onsuccess = e => resolve(e.target.result);
        addReq.onerror   = e => reject(e.target.error);
      }
    };
    getReq.onerror = e => reject(e.target.error);
  });
}

async function getAllBooks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req   = store.getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function getBookById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req   = store.get(id);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function deleteBookFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req   = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ============================================================
//  LIBRARY UI
// ============================================================
async function renderLibrary() {
  const grid  = document.getElementById("libraryGrid");
  const empty = document.getElementById("libraryEmpty");
  grid.innerHTML = "";

  let books;
  try { books = await getAllBooks(); }
  catch(e) { books = []; }

  // Sort by lastRead desc
  books.sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0));

  if (books.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  books.forEach(book => {
    const card  = document.createElement("div");
    card.className = "book-card";

    const icon  = document.createElement("div");
    icon.className = "book-card-icon";
    icon.textContent = book.type === "pdf" ? "📄" : "📖";
    card.appendChild(icon);

    const title = document.createElement("div");
    title.className = "book-card-title";
    title.textContent = book.name.replace(/\.(pdf|epub)$/i, "");
    card.appendChild(title);

    const typeLabel = document.createElement("div");
    typeLabel.className = "book-card-type";
    typeLabel.textContent = book.type.toUpperCase();
    card.appendChild(typeLabel);

    // Delete button
    const del = document.createElement("button");
    del.className = "book-card-delete";
    del.textContent = "✕";
    del.title = "Remove from library";
    del.addEventListener("click", async function(e) {
      e.stopPropagation();
      if (confirm("Remove \u201c" + book.name + "\u201d from your library?")) {
        await deleteBookFromDB(book.id);
        renderLibrary();
      }
    });
    card.appendChild(del);

    card.addEventListener("click", function() {
      openBookFromDB(book);
    });

    grid.appendChild(card);
  });
}

async function openBookFromDB(book) {
  currentBookName = book.name;
  currentBookType = book.type;

  // Update lastRead
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put({ ...book, lastRead: Date.now() });

  showReader(book.name);

  if (book.type === "pdf") {
    loadPDF(book.data, book.name);
  } else {
    loadEPUB(book.data, book.name);
  }
}

function showReader(bookName) {
  document.getElementById("homeScreen").style.display = "none";
  document.getElementById("reader").style.display    = "flex";
  document.getElementById("currentBookTitle").textContent = bookName.replace(/\.(pdf|epub)$/i, "");
  // Reset character state for new book
  detectedCharacters = {};
  characterColors    = {};
  characterStyles    = {};
  characterIcons     = {};
  updateCharacterList();
}

// ============================================================
//  FILE UPLOAD
// ============================================================
document.getElementById("fileUpload").addEventListener("change", async function(event) {
  const file = event.target.files[0];
  if (!file) return;

  const fileType = file.name.split(".").pop().toLowerCase();
  if (fileType !== "pdf" && fileType !== "epub") {
    showToast("Unsupported file type. Please choose a PDF or EPUB.");
    return;
  }

  // Read file as ArrayBuffer
  const arrayBuffer = await readFileAsArrayBuffer(file);

  // Save to library
  try { await saveBookToDB(file.name, fileType, arrayBuffer); }
  catch(e) { console.warn("Could not save to library:", e); }

  // Refresh library grid in background
  renderLibrary();

  // Open it
  currentBookName = file.name;
  currentBookType = fileType;
  showReader(file.name);

  if (fileType === "pdf") {
    loadPDF(arrayBuffer, file.name);
  } else {
    loadEPUB(arrayBuffer, file.name);
  }

  // reset input so same file can be re-selected
  this.value = "";
});

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = e => reject(e.target.error);
    reader.readAsArrayBuffer(file);
  });
}

// Back button
document.getElementById("backBtn").addEventListener("click", function() {
  // Tear down EPUB rendition if active
  if (rendition) {
    try { rendition.destroy(); } catch(e) {}
    rendition = null;
  }
  currentPDF = null;
  document.getElementById("pdfCanvas").style.display  = "none";
  document.getElementById("epubViewer").style.display = "none";
  document.getElementById("reader").style.display     = "none";
  document.getElementById("homeScreen").style.display = "block";
  setProgress(0);
  renderLibrary();
});

// ============================================================
//  PDF LOADER
// ============================================================
function setProgress(pct) {
  document.getElementById("progressFill").style.width = pct + "%";
}

async function loadPDF(arrayBuffer, filename) {
  const typedarray = new Uint8Array(arrayBuffer);
  currentPDF = await pdfjsLib.getDocument(typedarray).promise.catch(err => {
    showToast("Could not load PDF: " + err.message);
    document.getElementById("homeScreen").style.display = "block";
    document.getElementById("reader").style.display     = "none";
    return null;
  });
  if (!currentPDF) return;

  totalPages = currentPDF.numPages;
  const savedPdfPage = parseInt(localStorage.getItem("savedPage_pdf_" + filename));
  currentPage = (savedPdfPage && savedPdfPage <= totalPages) ? savedPdfPage : 1;

  document.getElementById("pdfCanvas").style.display  = "block";
  document.getElementById("epubViewer").style.display = "none";
  const pct = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;
  document.getElementById("pageInfo").innerText = "Page " + currentPage + " of " + totalPages;
  setProgress(pct);

  renderPDFPage(currentPage);
}

async function renderPDFPage(pageNum) {
  const page    = await currentPDF.getPage(pageNum);
  const canvas  = document.getElementById("pdfCanvas");
  const context = canvas.getContext("2d");

  // Fit to available width
  const content   = document.getElementById("readingContent");
  const available = content.offsetWidth - 80;
  const vp1       = page.getViewport({ scale: 1 });
  const scale     = Math.min(1.5, available / vp1.width);
  const viewport  = page.getViewport({ scale });

  canvas.height  = viewport.height;
  canvas.width   = viewport.width;

  await page.render({ canvasContext: context, viewport }).promise;

  const pct = totalPages > 0 ? Math.round((pageNum / totalPages) * 100) : 0;
  document.getElementById("pageInfo").innerText = "Page " + pageNum + " of " + totalPages;
  setProgress(pct);
}

// ============================================================
//  EPUB LOADER
// ============================================================
function loadEPUB(arrayBuffer, filename) {
  document.getElementById("epubViewer").style.display = "block";
  document.getElementById("pdfCanvas").style.display  = "none";

  const savedKey = "savedPage_epub_" + filename;
  const book     = ePub(arrayBuffer.slice(0)); // slice to avoid detached buffer issues

  const viewer  = document.getElementById("epubViewer");
  const content = document.getElementById("readingContent");
  rendition = book.renderTo("epubViewer", {
    manager: "default",
    flow:    "paginated",
    spread:  "none",
    width:   content.offsetWidth  || window.innerWidth,
    height:  content.offsetHeight || window.innerHeight - 90
  });

  rendition.themes.fontSize(currentFontSize + "%");

  const savedCfi = localStorage.getItem(savedKey);
  rendition.display(savedCfi || undefined);

  rendition.hooks.content.register(function(contents) {
    const text = contents.document.body.innerText;
    detectCharacters(text);
    updateCharacterList();
    if (Object.keys(detectedCharacters).length > 0) {
      highlightCharacters(contents);
    }
    injectCapitalWordClicker(contents);
    applyFontToContents(contents);
    // Apply dark mode if active
    if (document.body.classList.contains("dark")) {
      let ds = contents.document.getElementById("sl-dark-style");
      if (!ds) {
        ds = contents.document.createElement("style");
        ds.id = "sl-dark-style";
        contents.document.head.appendChild(ds);
      }
      // Dark mode styles with more visible highlights
      ds.textContent = `
        body,html{background:#1a1612!important;color:#e8dfd0!important}
        span[data-char-name]{opacity:1!important}
        span[data-char-name][style*="border-bottom"]{border-bottom-color:inherit!important}
      `;
    }
  });

  book.ready.then(function() {
    book.locations.generate(1024).then(function() {
      const loc = rendition.currentLocation();
      if (loc && loc.start) {
        const pct = book.locations.percentageFromCfi(loc.start.cfi);
        if (pct != null) {
          document.getElementById("pageInfo").innerText = Math.round(pct * 100) + "% read";
        }
      }
    });
  });

  rendition.on("relocated", function(location) {
    if (location && location.start) {
      let pct = null;
      if (book.locations && book.locations.total > 0) {
        pct = book.locations.percentageFromCfi(location.start.cfi);
      } else if (location.start.percentage != null) {
        pct = location.start.percentage;
      }
      const pctNum = pct != null ? Math.round(pct * 100) : null;
      document.getElementById("pageInfo").innerText =
        pctNum != null ? pctNum + "% read" : "—";
      if (pctNum != null) setProgress(pctNum);
    }
  });

  book.loaded.navigation.then(function(nav) {
    buildChapterList(nav.toc, rendition);
  });

  document.getElementById("savePageBtn").onclick = function() {
    const location = rendition.currentLocation();
    const cfi      = location && location.start && location.start.cfi;
    if (cfi) {
      localStorage.setItem(savedKey, cfi);
      showToast("📍 Position saved!");
    }
  };
}

function buildChapterList(toc, rendition) {
  const panel = document.getElementById("chapterPanel");
  const list  = document.getElementById("chapterList");
  list.innerHTML = "";

  if (!toc || toc.length === 0) { panel.style.display = "none"; return; }
  panel.style.display = "block";

  function addItems(items, depth) {
    items.forEach(item => {
      const div  = document.createElement("div");
      div.textContent    = item.label.trim();
      div.style.paddingLeft = (depth * 12) + "px";
      div.className      = "chapter-item";
      div.onclick        = () => rendition.display(item.href);
      list.appendChild(div);
      if (item.subitems && item.subitems.length > 0) addItems(item.subitems, depth + 1);
    });
  }
  addItems(toc, 0);
}

// ============================================================
//  NAVIGATION
// ============================================================
function nextPage() {
  if (currentPDF) {
    if (currentPage < totalPages) { currentPage++; renderPDFPage(currentPage); }
  } else if (rendition) {
    rendition.next();
  }
}
function prevPage() {
  if (currentPDF) {
    if (currentPage > 1) { currentPage--; renderPDFPage(currentPage); }
  } else if (rendition) {
    rendition.prev();
  }
}

document.getElementById("nextBtn").addEventListener("click", nextPage);
document.getElementById("prevBtn").addEventListener("click", prevPage);

window.addEventListener("resize", function() {
  if (rendition) {
    const content = document.getElementById("readingContent");
    rendition.resize(content.offsetWidth, content.offsetHeight);
  }
});

// ============================================================
//  SWIPE NAVIGATION & TAP TO TOGGLE (touch devices)
// ============================================================
(function() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tapTimeout = null;
  let hasSwiped = false;
  
  const readingArea = document.getElementById("readingArea");
  const topBar = document.getElementById("topBar");
  const bottomBar = document.getElementById("bottomBar");
  const isMobile = window.innerWidth <= 680;

  readingArea.addEventListener("touchstart", function(e) {
    touchStartX = e.changedTouches[0].clientX;
    touchStartY = e.changedTouches[0].clientY;
    hasSwiped = false;
    clearTimeout(tapTimeout);
  }, { passive: true });

  readingArea.addEventListener("touchmove", function(e) {
    const dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (dx > 30 || dy > 30) {
      hasSwiped = true;
      clearTimeout(tapTimeout);
    }
  }, { passive: true });

  readingArea.addEventListener("touchend", function(e) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    
    // Horizontal swipe for page navigation
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) {
        nextPage(); // swipe left → next
      } else {
        prevPage(); // swipe right → prev
      }
      return;
    }
    
    // Mobile: tap to toggle fullscreen bars
    if (isMobile && !hasSwiped && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      tapTimeout = setTimeout(function() {
        const topBarHidden = topBar.classList.contains("hidden");
        const bottomBarHidden = bottomBar.classList.contains("hidden");
        
        if (topBarHidden && bottomBarHidden) {
          // Show both bars
          topBar.classList.remove("hidden");
          bottomBar.classList.remove("hidden");
        } else if (!topBarHidden && !bottomBarHidden) {
          // Hide both bars for fullscreen
          topBar.classList.add("hidden");
          bottomBar.classList.add("hidden");
        } else {
          // Sync state - show both
          topBar.classList.remove("hidden");
          bottomBar.classList.remove("hidden");
        }
      }, 150);
    }
  }, { passive: true });
})();

// ============================================================
//  KEYBOARD NAVIGATION
// ============================================================
document.addEventListener("keydown", function(e) {
  if (document.getElementById("reader").style.display === "none") return;
  if (document.getElementById("settingsPopup").classList.contains("open")) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") nextPage();
  if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   prevPage();
});



// ============================================================
//  SETTINGS PANEL
// ============================================================
document.getElementById("settingsBtn").addEventListener("click", function() {
  document.getElementById("settingsPopup").classList.add("open");
});
document.getElementById("settingsClose").addEventListener("click", function() {
  document.getElementById("settingsPopup").classList.remove("open");
});
document.getElementById("settingsPopup").addEventListener("click", function(e) {
  if (e.target === this) this.classList.remove("open");
});

const FONT_FAMILIES = {
  default:      'Georgia, "Times New Roman", serif',
  literata:     '"Literata", Georgia, serif',
  merriweather: '"Merriweather", Georgia, serif',
  lora:         '"Lora", Georgia, serif',
  atkinson:     '"Atkinson Hyperlegible", Arial, sans-serif',
  opendyslexic: '"OpenDyslexic", sans-serif',
};

function applyFontToContents(contents) {
  // remove old injected style
  const old = contents.document.getElementById("sl-font-style");
  if (old) old.remove();

  if (currentFont === 'default') return;

  const style = contents.document.createElement("style");
  style.id = "sl-font-style";

  let css = '';
  if (currentFont === 'opendyslexic') {
    css += DYSLEXIC_FONT_CSS;
  } else {
    // embed Google Font link inside the iframe document
    const existing = contents.document.getElementById("sl-gfont-link");
    if (existing) existing.remove();
    const link = contents.document.createElement("link");
    link.id   = "sl-gfont-link";
    link.rel  = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=Literata:ital,opsz,wght@0,7..72,300..700;1,7..72,300..700&family=Lora:ital,wght@0,400..700;1,400..700&family=Merriweather:ital,wght@0,300;0,400;0,700;1,300;1,400&display=swap";
    contents.document.head.appendChild(link);
  }

  css += `* { font-family: ${FONT_FAMILIES[currentFont]} !important; }`;
  style.textContent = css;
  contents.document.head.appendChild(style);
}

document.getElementById("fontSelect").addEventListener("change", function() {
  currentFont = this.value;

  // apply to the main document (PDF / non-EPUB text)
  document.body.style.fontFamily = currentFont === 'default' ? '' : FONT_FAMILIES[currentFont];

  if (rendition) {
    rendition.getContents().forEach(contents => applyFontToContents(contents));
  }
});

let currentFontSize = 100;
document.getElementById("fontSizeSlider").addEventListener("input", function() {
  currentFontSize = parseInt(this.value);
  document.getElementById("fontSizeValue").textContent = currentFontSize + "%";
  if (rendition) rendition.themes.fontSize(currentFontSize + "%");
});

// PDF save page
document.getElementById("savePageBtn").addEventListener("click", function() {
  if (currentPDF) {
    localStorage.setItem("savedPage_pdf_" + currentBookName, currentPage);
    showToast("📍 Page " + currentPage + " saved!");
  }
});

document.getElementById("saveColor").addEventListener("click", function() {
  if (rendition) {
    rendition.getContents().forEach(contents => highlightCharacters(contents));
  }
});

// ============================================================
//  CHARACTER DETECTION
// ============================================================
const NON_NAME_WORDS = new Set([
    "The","And","But","For","Yet","Nor","So","Or","An","In","On","At","To","Of","By","As","Up","If","Into","From","With","About","Like",
    "He","She","It","We","You","They","His","Her","Its","Our","Your","Their","My","Me","Him","Us","Them","Himself","Herself","Itself","Themselves","Yourself","Ourselves",
    "This","That","These","Those","What","Which","Who","Whom","Whose","When","Where","Why","How","Whether",
    "All","Any","Each","Every","Few","More","Most","Other","Some","Such","None","Both","Either","Neither","Another","Enough","Several","Many","Much","Less","Least",
    "No","Not","Only","Own","Same","Than","Too","Very","Just","Quite","Rather","Almost","Already","Also","Even","Still",
    "Because","While","Although","Though","Since","Until","Unless","Whether","After","Before","During","Between","Among","Through","Without","Within","Against","Along","Following","Across","Behind","Beyond","Plus","Except","Despite","Instead","Whereas","Whereby",
    "However","Therefore","Moreover","Furthermore","Nevertheless","Meanwhile","Otherwise","Accordingly","Consequently","Indeed","Likewise","Similarly","Hence","Thus","Nonetheless",
    "Chapter","Part","Section","Volume","Book","Page","Preface","Introduction","Appendix","Index","Contents","Prologue","Epilogue",
    "One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Hundred","Thousand","Million","Billion",
    "First","Second","Third","Fourth","Fifth","Sixth","Seventh","Eighth","Ninth","Tenth","Last","Next","Previous","Former","Latter",
    "New","Old","Good","Great","Little","Long","Big","High","Low","Real","True","False","Hard","Soft","Dark","Light","Young","Small","Large","Full","Empty","Early","Late","Free","Open","Close","Clear","Bright","Strong","Weak","Fast","Slow","Hot","Cold","Warm","Cool",
    "Said","Told","Asked","Replied","Answered","Thought","Felt","Knew","Saw","Heard","Came","Went","Got","Made","Took","Gave","Seemed","Looked","Turned","Found","Kept","Left","Put","Set","Let","Led","Stood","Walked","Ran","Sat","Lay","Tried","Wanted","Needed","Appeared","Became","Remained",
    "There","Here","Now","Then","Still","Again","Always","Never","Often","Well","Even","Back","Down","Over","Under","Around","Away","Once","Twice","Soon","Suddenly","Quickly","Slowly","Simply","Merely","Perhaps","Maybe","Probably","Certainly","Clearly","Truly","Really",
    "Dear","Please","Sorry","Thank","Yes","Whose","Into","Onto","Upon",
    "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday","January","February","March","April","May","June","July","August","September","October","November","December"
]);

// Honorifics that precede a name
const HONORIFICS = new Set([
  "Mr","Mrs","Miss","Ms","Dr","Prof","Sir","Lord","Lady","Captain","Capt","Sgt","Lt","Col","Gen","Rev","Fr","Sr","Jr","Mx"
]);

function detectCharacters(text) {
  // 1. Detect "Honorific. Name" pairs (e.g. "Mr. Darcy", "Dr Smith")
  const honorificRe = /\b(Mr|Mrs|Miss|Ms|Dr|Prof|Sir|Lord|Lady|Captain|Capt|Sgt|Lt|Col|Gen|Rev|Fr|Sr|Jr|Mx)\.?\s+([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})?)/g;
  let m;
  while ((m = honorificRe.exec(text)) !== null) {
    const fullName = m[0].replace(/\s+/g, " ").trim();
    detectedCharacters[fullName] = (detectedCharacters[fullName] || 0) + 2; // weight higher
  }

  // 2. Match standalone capitalised words (at least 3 chars)
  let words = text.match(/\b[A-Z][a-z]{2,}\b/g);
  if (!words) return;
  words.forEach(word => {
    if (NON_NAME_WORDS.has(word)) return;
    if (HONORIFICS.has(word)) return;
    detectedCharacters[word] = (detectedCharacters[word] || 0) + 1;
  });
}

function updateCharacterList() {
  const list = document.getElementById("characterList");
  list.innerHTML = "";

  Object.keys(detectedCharacters)
    .sort((a, b) => detectedCharacters[b] - detectedCharacters[a])
    .slice(0, 30)
    .forEach(name => {
      const div   = document.createElement("div");
      const color = characterColors[name];
      const icon  = characterIcons[name];

      if (color) {
        const dot = document.createElement("span");
        dot.style.cssText = "display:inline-block;width:10px;height:10px;border-radius:50%;background:" + color + ";flex-shrink:0;";
        div.appendChild(dot);
      }
      if (icon && icon !== "none" && ICON_MAP[icon]) {
        const sym = document.createElement("span");
        sym.textContent = ICON_MAP[icon];
        sym.style.cssText = "font-size:0.75em;flex-shrink:0;color:" + (color || "inherit") + ";";
        div.appendChild(sym);
      }
      div.appendChild(document.createTextNode(name));

      // Clicking from character list opens the inline color picker
      const handler = function(e) {
        // Use center of the div as position
        const rect = div.getBoundingClientRect();
        openInlineColorPicker(name, rect.left, rect.bottom + 6);
        e.stopPropagation();
      };
      div.addEventListener("click",      handler);
      div.addEventListener("touchstart", handler, { passive: true });

      list.appendChild(div);
    });
}

// ============================================================
//  HIGHLIGHT CHARACTERS IN EPUB
// ============================================================
function highlightCharacters(contents) {
  const doc = contents.document;

  if (doc.body) {
    doc.body.setAttribute("spellcheck", "false");
    doc.body.style.webkitSpellCheck = "false";
  }

  // Strip existing highlight spans
  doc.querySelectorAll("span[data-char-name]").forEach(span => {
    const text = doc.createTextNode(span.textContent);
    span.parentNode.replaceChild(text, span);
  });
  doc.body.normalize();

  const allNames = Object.keys(detectedCharacters);

  // Sort names longest-first so multi-word names match before single words
  allNames.sort((a, b) => b.length - a.length);

  allNames.forEach(name => {
    const color = characterColors[name] || null;
    const icon  = characterIcons[name]  || "none";

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null, false);
    const matchingNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (new RegExp(escapeRegex(name)).test(node.nodeValue)) {
        matchingNodes.push(node);
      }
    }

    matchingNodes.forEach(node => {
      const spanTemplate = doc.createElement("span");
      spanTemplate.style.cursor = "pointer";
      spanTemplate.dataset.charName = name;
      applySpanStyle(spanTemplate, color, characterStyles[name] || "underline", icon);

      const parts    = node.nodeValue.split(new RegExp("(" + escapeRegex(name) + ")"));
      const fragment = doc.createDocumentFragment();

      parts.forEach((part, index) => {
        if (index % 2 === 0) {
          fragment.appendChild(doc.createTextNode(part));
        } else {
          const s = spanTemplate.cloneNode(false); // shallow clone — no icon child yet
          s.textContent = part;
          applySpanStyle(s, color, characterStyles[name] || "underline", icon);
          attachSpanHandlers(s);
          fragment.appendChild(s);
        }
      });

      node.parentNode.replaceChild(fragment, node);
    });
  });
}

const ICON_MAP = { star: "★", dot: "●", triangle: "▲", diamond: "◆" };

function applySpanStyle(span, color, style, icon) {
  // Reset
  span.style.background       = "";
  span.style.backgroundImage  = "";
  span.style.backgroundRepeat = "";
  span.style.backgroundSize   = "";
  span.style.color            = "";
  span.style.padding          = "";
  span.style.borderRadius     = "";
  span.style.borderBottom     = "";
  span.style.paddingBottom    = "";

  // Remove any existing icon pseudo-element via data attr
  span.removeAttribute("data-char-icon");

  if (color) {
    if (style === "solid") {
      span.style.background    = color;
      // Use black text for better contrast on vibrant colors in light mode
      span.style.color         = "#000000";
      span.style.textShadow    = "0 0 2px rgba(255,255,255,0.5)";
      span.style.padding       = "3px 6px";
      span.style.borderRadius  = "8px"; // More rounded corners
    } else if (style === "ombre") {
      span.style.backgroundImage  = "linear-gradient(to top, " + color + "dd 0%, transparent 100%)";
      span.style.backgroundRepeat = "no-repeat";
      span.style.backgroundSize   = "100% 100%";
      span.style.padding          = "3px 6px";
      span.style.borderRadius     = "8px"; // More rounded corners
      span.style.color            = "#000000";
    } else {
      // Rounded underline style - thicker and more visible
      span.style.borderBottom  = "4px dashed " + color;
      span.style.paddingBottom = "3px";
      span.style.borderRadius  = "4px";
    }
  }

  // Prepend icon if chosen
  if (icon && icon !== "none" && ICON_MAP[icon]) {
    const sym = ICON_MAP[icon];
    // Store on span so we can re-apply; actual rendering via ::before isn't possible in JS,
    // so we inject a tiny inline element
    const existing = span.querySelector("span[data-icon]");
    if (existing) existing.remove();
    const iconEl = span.ownerDocument ? span.ownerDocument.createElement("span") : document.createElement("span");
    iconEl.setAttribute("data-icon", icon);
    iconEl.style.cssText = "font-size:0.65em;vertical-align:super;margin-right:1px;color:" + (color || "inherit") + ";user-select:none;";
    iconEl.textContent = sym;
    span.insertBefore(iconEl, span.firstChild);
  }
}

// Helper function to adjust color brightness for better text contrast
function adjustColorBrightness(hex, percent) {
  // Remove # if present
  hex = hex.replace(/^#/, '');
  
  // Parse the hex color
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);
  
  // Adjust brightness
  r = Math.min(255, Math.max(0, r + percent));
  g = Math.min(255, Math.max(0, g + percent));
  b = Math.min(255, Math.max(0, b + percent));
  
  // Convert back to hex
  return "#" + 
    r.toString(16).padStart(2, '0') + 
    g.toString(16).padStart(2, '0') + 
    b.toString(16).padStart(2, '0');
}

function attachSpanHandlers(s) {
  function handleActivation(e) {
    e.stopPropagation();
    const charName = s.dataset.charName;
    let absX, absY;

    // Handle touch events first (for iOS)
    if (e.type === "touchstart" || e.type === "touchend") {
      const touch = e.changedTouches && e.changedTouches.length > 0 
        ? e.changedTouches[0] 
        : (e.touches && e.touches.length > 0 ? e.touches[0] : null);
      if (touch) {
        absX = touch.clientX;
        absY = touch.clientY;
      }
    }
    
    // Fall back to mouse/click coordinates
    if (absX === undefined || absY === undefined) {
      absX = e.clientX;
      absY = e.clientY;
    }

    try {
      const iframes = window.parent.document.querySelectorAll("iframe");
      iframes.forEach(function(iframe) {
        if (iframe.contentWindow === window) {
          const rect = iframe.getBoundingClientRect();
          absX += rect.left;
          absY += rect.top;
        }
      });
    } catch(err) {}

    const opener = (window.parent && window.parent.openInlineColorPicker)
      ? window.parent.openInlineColorPicker
      : openInlineColorPicker;
    opener(charName, absX, absY);
  }

  // Use pointer events for better cross-device support
  s.style.touchAction = "manipulation";
  
  // Add touchstart for immediate response on iOS
  s.addEventListener("touchstart", function(e) {
    e.stopPropagation();
    // Store touch coordinates for use in touchend
    if (e.changedTouches && e.changedTouches.length > 0) {
      s._touchStartX = e.changedTouches[0].clientX;
      s._touchStartY = e.changedTouches[0].clientY;
    }
  }, { passive: true });
  
  s.addEventListener("touchend", function(e) {
    e.preventDefault();
    e.stopPropagation();
    
    let absX, absY;
    // Use stored touch coordinates or current
    if (e.changedTouches && e.changedTouches.length > 0) {
      absX = e.changedTouches[0].clientX;
      absY = e.changedTouches[0].clientY;
    } else if (s._touchStartX !== undefined) {
      absX = s._touchStartX;
      absY = s._touchStartY;
    }
    
    if (absX !== undefined && absY !== undefined) {
      const charName = s.dataset.charName;
      
      try {
        const iframes = window.parent.document.querySelectorAll("iframe");
        iframes.forEach(function(iframe) {
          if (iframe.contentWindow === window) {
            const rect = iframe.getBoundingClientRect();
            absX += rect.left;
            absY += rect.top;
          }
        });
      } catch(err) {}

      const opener = (window.parent && window.parent.openInlineColorPicker)
        ? window.parent.openInlineColorPicker
        : openInlineColorPicker;
      opener(charName, absX, absY);
    }
  }, { passive: false });
  
  // Keep click handler as fallback for non-touch devices
  s.addEventListener("click", handleActivation);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
//  CAPITAL WORD CLICKER  +  TEXT SELECTION HANDLER
//  (lets user tap any capital word, or select foreign names)
// ============================================================
function injectCapitalWordClicker(contents) {
  const doc = contents.document;

  // --- mouseup handler ---
  if (doc._capitalClickHandler) {
    doc.removeEventListener("mouseup", doc._capitalClickHandler);
  }
  doc._capitalClickHandler = function(e) {
    handleWordInteraction(e, contents, "mouse");
  };
  doc.addEventListener("mouseup", doc._capitalClickHandler);

  // --- touchend handler ---
  if (doc._capitalTouchHandler) {
    doc.removeEventListener("touchend", doc._capitalTouchHandler);
  }
  
  // Store touch start position for better iOS handling
  let touchStartX = 0;
  let touchStartY = 0;
  
  if (doc._touchStartHandler) {
    doc.removeEventListener("touchstart", doc._touchStartHandler);
  }
  doc._touchStartHandler = function(e) {
    if (e.changedTouches && e.changedTouches.length > 0) {
      touchStartX = e.changedTouches[0].clientX;
      touchStartY = e.changedTouches[0].clientY;
    }
  };
  doc.addEventListener("touchstart", doc._touchStartHandler, { passive: true });
  
  doc._capitalTouchHandler = function(e) {
    // Check if this is a tap (not a swipe) - minimal movement
    let dx = 0, dy = 0;
    if (e.changedTouches && e.changedTouches.length > 0) {
      dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
      dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    }
    // Only handle as tap if movement is minimal
    if (dx < 10 && dy < 10) {
      e.preventDefault();
    }
    handleWordInteraction(e, contents, "touch");
  };
  doc.addEventListener("touchend", doc._capitalTouchHandler, { passive: false });
  
  // Also add click handler for iOS Safari which sometimes converts taps to clicks
  if (doc._capitalTapHandler) {
    doc.removeEventListener("click", doc._capitalTapHandler);
  }
  doc._capitalTapHandler = function(e) {
    // Only handle if target is text content (not already a highlighted span)
    if (e.target && e.target.dataset && e.target.dataset.charName) return;
    if (e.target && (e.target.tagName === 'SPAN' || e.target.tagName === 'DIV')) return;
    handleWordInteraction(e, contents, "mouse");
  };
  doc.addEventListener("click", doc._capitalTapHandler);
}

function handleWordInteraction(e, contents, mode) {
  const doc = contents.document;

  // First, check if there is a user text selection (for foreign names)
  const sel = doc.getSelection ? doc.getSelection() : null;
  if (sel && sel.toString().trim().length > 0) {
    const selectedText = sel.toString().trim();
    // Accept any sequence of letters (supports accented/foreign characters)
    if (/^[\p{L}][\p{L}\s\-']{1,}/u.test(selectedText) || /^\S{2,}$/.test(selectedText)) {
      let absX = 0, absY = 0;
      try {
        const range = sel.getRangeAt(0);
        const rect  = range.getBoundingClientRect();
        absX = rect.left + rect.width / 2;
        absY = rect.bottom;
        const iframes = window.parent.document.querySelectorAll("iframe");
        iframes.forEach(function(iframe) {
          if (iframe.contentWindow === (doc.defaultView || window)) {
            const ifrect = iframe.getBoundingClientRect();
            absX += ifrect.left;
            absY += ifrect.top;
          }
        });
      } catch(err) {}

      sel.removeAllRanges();
      showAddCharPrompt(selectedText, absX, absY, contents);
      return;
    }
  }

  // Skip if clicking an existing highlighted span (already handled)
  if (e.target && e.target.dataset && e.target.dataset.charName) return;

  // Get coordinates
  let cx = e.clientX, cy = e.clientY;
  if (mode === "touch") {
    const touches = e.changedTouches || e.touches;
    if (touches && touches.length > 0) { cx = touches[0].clientX; cy = touches[0].clientY; }
    else return;
  }

  // Get word at caret
  let word = null;
  try {
    let range;
    if (doc.caretRangeFromPoint) {
      range = doc.caretRangeFromPoint(cx, cy);
    } else if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(cx, cy);
      range = doc.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.setEnd(pos.offsetNode, pos.offset);
    }
    if (range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      const text   = range.startContainer.nodeValue;
      const offset = range.startOffset;
      let start = offset, end = offset;
      while (start > 0 && /\w/.test(text[start - 1])) start--;
      while (end < text.length && /\w/.test(text[end])) end++;
      word = text.slice(start, end);
    }
  } catch(err) {}

  if (!word) return;
  // Must start with capital, be at least 3 chars, not already listed
  if (!/^[A-Z][a-z]{2,}$/.test(word)) return;
  if (detectedCharacters[word]) return;

  let absX = cx, absY = cy;
  try {
    const iframes = window.parent.document.querySelectorAll("iframe");
    iframes.forEach(function(iframe) {
      if (iframe.contentWindow === (doc.defaultView || window)) {
        const rect = iframe.getBoundingClientRect();
        absX += rect.left;
        absY += rect.top;
      }
    });
  } catch(err) {}

  detectedCharacters[word] = 1;
  updateCharacterList();
  highlightCharacters(contents);

  const opener = (window.parent && window.parent.openInlineColorPicker)
    ? window.parent.openInlineColorPicker
    : openInlineColorPicker;
  opener(word, absX, absY);
}

// ============================================================
//  ADD CHARACTER PROMPT  (for foreign/unrecognised names)
// ============================================================
let addCharContents = null;

function showAddCharPrompt(word, x, y, contents) {
  addCharContents = contents;
  const prompt = document.getElementById("addCharPrompt");
  document.getElementById("addCharWord").textContent = "\u201c" + word + "\u201d";
  const pw = 220, ph = 80;
  const vw = window.innerWidth, vh = window.innerHeight;
  prompt.style.left    = Math.min(x, vw - pw) + "px";
  prompt.style.top     = Math.min(y + 6, vh - ph) + "px";
  prompt.style.display = "block";
  prompt.dataset.word  = word;
}

document.getElementById("addCharConfirm").addEventListener("click", function() {
  const prompt = document.getElementById("addCharPrompt");
  const word   = prompt.dataset.word;
  prompt.style.display = "none";
  if (!word) return;

  // Add to detected characters if not already there
  if (!detectedCharacters[word]) detectedCharacters[word] = 1;
  updateCharacterList();
  if (addCharContents) highlightCharacters(addCharContents);

  // Open color picker
  openInlineColorPicker(word, parseInt(prompt.style.left) || 100, parseInt(prompt.style.top) || 100);
  addCharContents = null;
});

document.getElementById("addCharDismiss").addEventListener("click", function() {
  document.getElementById("addCharPrompt").style.display = "none";
  addCharContents = null;
});

// ============================================================
//  INLINE COLOR PICKER
// ============================================================
let inlineTargetChar = null;

// Vibrant color palette - high distinction for character identification
const PASTEL_COLORS = [
  "#E57373", // soft red
  "#FFB74D", // soft orange
  "#FFF176", // soft yellow
  "#81C784", // soft green
  "#64B5F6", // soft blue
  "#BA68C8", // soft purple
  "#F06292", // soft pink
  "#4DD0E1", // soft cyan
  "#AED581", // soft lime
  "#FF8A65", // soft deep orange
  "#9575CD", // soft deep purple
  "#A1887F", // soft brown
];

// Initialize color palette on page load
function initColorPalette() {
  const palette = document.getElementById("colorPalette");
  if (!palette) return;
  palette.innerHTML = "";
  
  PASTEL_COLORS.forEach(color => {
    const swatch = document.createElement("div");
    swatch.className = "color-swatch";
    swatch.style.backgroundColor = color;
    swatch.dataset.color = color;
    swatch.title = color;
    
    swatch.addEventListener("click", function() {
      // Update selection state
      document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("selected"));
      swatch.classList.add("selected");
      // Update color input
      document.getElementById("inlineColor").value = color;
    });
    
    // Touch support
    swatch.addEventListener("touchstart", function(e) {
      e.preventDefault();
      document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("selected"));
      swatch.classList.add("selected");
      document.getElementById("inlineColor").value = color;
    }, { passive: false });
    
    palette.appendChild(swatch);
  });
}

// ============================================================
//  DRAG FUNCTIONALITY FOR INLINE COLOR PICKER
// ============================================================
(function() {
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const picker = document.getElementById("inlineColorPicker");
  
  if (!picker) return;
  
  // Mouse events
  picker.addEventListener("mousedown", function(e) {
    // Don't drag if clicking on buttons or inputs
    if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT" || e.target.closest("button") || e.target.closest("input")) {
      return;
    }
    isDragging = true;
    dragOffsetX = e.clientX - picker.offsetLeft;
    dragOffsetY = e.clientY - picker.offsetTop;
    picker.style.cursor = "grabbing";
  });
  
  document.addEventListener("mousemove", function(e) {
    if (!isDragging) return;
    let newX = e.clientX - dragOffsetX;
    let newY = e.clientY - dragOffsetY;
    
    // Keep within viewport
    newX = Math.max(0, Math.min(newX, window.innerWidth - picker.offsetWidth));
    newY = Math.max(0, Math.min(newY, window.innerHeight - picker.offsetHeight));
    
    picker.style.left = newX + "px";
    picker.style.top = newY + "px";
  });
  
  document.addEventListener("mouseup", function() {
    if (isDragging) {
      isDragging = false;
      picker.style.cursor = "move";
    }
  });
  
  // Touch events for mobile/tablet
  picker.addEventListener("touchstart", function(e) {
    // Don't drag if touching buttons or inputs
    if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT" || e.target.closest("button") || e.target.closest("input")) {
      return;
    }
    const touch = e.touches[0];
    isDragging = true;
    dragOffsetX = touch.clientX - picker.offsetLeft;
    dragOffsetY = touch.clientY - picker.offsetTop;
  }, { passive: true });
  
  picker.addEventListener("touchmove", function(e) {
    if (!isDragging) return;
    e.preventDefault(); // Prevent scrolling while dragging
    const touch = e.touches[0];
    let newX = touch.clientX - dragOffsetX;
    let newY = touch.clientY - dragOffsetY;
    
    // Keep within viewport
    newX = Math.max(0, Math.min(newX, window.innerWidth - picker.offsetWidth));
    newY = Math.max(0, Math.min(newY, window.innerHeight - picker.offsetHeight));
    
    picker.style.left = newX + "px";
    picker.style.top = newY + "px";
  }, { passive: false });
  
  picker.addEventListener("touchend", function() {
    isDragging = false;
  });
})();

// Initialize on load
initColorPalette();
initSettingsColorPalette();

function initSettingsColorPalette() {
  const palette = document.getElementById("settingsColorPalette");
  if (!palette) return;
  palette.innerHTML = "";
  
  PASTEL_COLORS.forEach(color => {
    const swatch = document.createElement("div");
    swatch.className = "color-swatch";
    swatch.style.backgroundColor = color;
    swatch.dataset.color = color;
    swatch.title = color;
    
    swatch.addEventListener("click", function() {
      document.querySelectorAll("#settingsColorPalette .color-swatch").forEach(s => s.classList.remove("selected"));
      swatch.classList.add("selected");
      document.getElementById("colorPicker").value = color;
    });
    
    swatch.addEventListener("touchstart", function(e) {
      e.preventDefault();
      document.querySelectorAll("#settingsColorPalette .color-swatch").forEach(s => s.classList.remove("selected"));
      swatch.classList.add("selected");
      document.getElementById("colorPicker").value = color;
    }, { passive: false });
    
    palette.appendChild(swatch);
  });
}

window.openInlineColorPicker = function openInlineColorPicker(name, x, y) {
  inlineTargetChar = name;
  const picker = document.getElementById("inlineColorPicker");
  document.getElementById("inlineCharName").textContent = name;
  
  const savedColor = characterColors[name] || "#ff0000";
  document.getElementById("inlineColor").value = savedColor;
  
  // Update palette selection
  document.querySelectorAll(".color-swatch").forEach(s => {
    s.classList.toggle("selected", s.dataset.color.toLowerCase() === savedColor.toLowerCase());
  });

  const savedStyle = characterStyles[name] || "underline";
  document.querySelectorAll('input[name="inlineStyle"]').forEach(function(r) {
    r.checked = r.value === savedStyle;
  });

  const savedIcon = characterIcons[name] || "none";
  document.querySelectorAll('input[name="inlineIcon"]').forEach(function(r) {
    r.checked = r.value === savedIcon;
  });

  const pw = 280, ph = 380;
  const vw = window.innerWidth, vh = window.innerHeight;
  picker.style.left    = Math.min(x + 8, vw - pw) + "px";
  picker.style.top     = Math.min(y + 8, vh - ph) + "px";
  picker.style.display = "block";
  // Close the settings panel if open (better UX on small screens)
  document.getElementById("settingsPopup").classList.remove("open");
};

document.getElementById("inlineApply").addEventListener("click", function() {
  if (!inlineTargetChar) return;
  const color = document.getElementById("inlineColor").value;
  const styleInput = document.querySelector('input[name="inlineStyle"]:checked');
  const iconInput  = document.querySelector('input[name="inlineIcon"]:checked');
  const style = styleInput ? styleInput.value : "underline";
  const icon  = iconInput  ? iconInput.value  : "none";
  characterColors[inlineTargetChar]  = color;
  characterStyles[inlineTargetChar]  = style;
  characterIcons[inlineTargetChar]   = icon;
  document.getElementById("inlineColorPicker").style.display = "none";
  updateCharacterList();
  if (rendition) {
    rendition.getContents().forEach(contents => highlightCharacters(contents));
  }
  inlineTargetChar = null;
});

document.getElementById("inlineClose").addEventListener("click", function() {
  document.getElementById("inlineColorPicker").style.display = "none";
  inlineTargetChar = null;
});

// Close pickers when tapping outside
document.addEventListener("click", function(e) {
  const picker = document.getElementById("inlineColorPicker");
  const prompt = document.getElementById("addCharPrompt");
  if (picker.style.display === "block" && !picker.contains(e.target)) {
    picker.style.display = "none";
    inlineTargetChar = null;
  }
  if (prompt.style.display === "block" && !prompt.contains(e.target)) {
    prompt.style.display = "none";
    addCharContents = null;
  }
});

// ============================================================
//  DARK MODE
// ============================================================
(function() {
  const btn = document.getElementById("darkModeBtn");
  const homeBtn = document.getElementById("homeDarkModeBtn");
  const saved = localStorage.getItem("sl_darkMode");
  if (saved === "1") {
    document.body.classList.add("dark");
    const btnLabel = document.querySelector("#darkModeBtn .btn-label");
    if (btnLabel) btnLabel.textContent = "Dark Mode";
  }
   
  function toggleDarkMode() {
    const isDark = document.body.classList.toggle("dark");
    // Update button labels
    const btnLabel = document.querySelector("#darkModeBtn .btn-label");
    if (btnLabel) btnLabel.textContent = isDark ? "Dark Mode" : "Light Mode";
    // Icons are toggled via CSS based on body.dark class
    localStorage.setItem("sl_darkMode", isDark ? "1" : "0");
    // Re-inject dark background into EPUB iframe if open
    if (rendition) {
      rendition.getContents().forEach(function(contents) {
        let style = contents.document.getElementById("sl-dark-style");
        if (isDark) {
          if (!style) {
            style = contents.document.createElement("style");
            style.id = "sl-dark-style";
            contents.document.head.appendChild(style);
          }
          // Dark mode styles with more visible highlights
          style.textContent = `
            body,html{background:#1a1612!important;color:#e8dfd0!important}
            span[data-char-name]{opacity:1!important}
            span[data-char-name][style*="border-bottom"]{border-bottom-color:inherit!important}
          `;
        } else {
          if (style) style.remove();
        }
      });
    }
  }
  
  if (btn) btn.addEventListener("click", toggleDarkMode);
  if (homeBtn) homeBtn.addEventListener("click", toggleDarkMode);
})();

// ============================================================
//  INIT
// ============================================================
renderLibrary();
