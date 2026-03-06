console.log("StoryLens running");

// PDF worker
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

let currentPDF = null;
let currentPage = 1;
let totalPages = 0;
let rendition = null;
let selectedFile = null;
let detectedCharacters = {};
let characterColors = {};
let dyslexicFontActive = false;
let characterStyles = {}; // per-character style: "underline" | "solid" | "ombre"
const DYSLEXIC_FONT_CSS = `
  @font-face {
    font-family: 'OpenDyslexic';
    src: url('fonts/OpenDyslexic/OpenDyslexic-Regular.otf') format('opentype');
  }
  * { font-family: 'OpenDyslexic', sans-serif !important; }
`;



// When user selects file, just store it
document.getElementById("fileUpload").addEventListener("change", function(event) {
  selectedFile = event.target.files[0];
});

// When user clicks Open Book button, load it
document.getElementById("openBtn").addEventListener("click", function() {
  if (!selectedFile) {
    alert("Choose a file first");
    return;
  }

  document.getElementById("uploadScreen").style.display = "none";
  document.getElementById("reader").style.display = "block";

  const fileType = selectedFile.name.split(".").pop().toLowerCase();

  if (fileType === "pdf") {
    loadPDF(selectedFile);
  } else if (fileType === "epub") {
    loadEPUB(selectedFile);
  } else {
    alert("Unsupported file type");
  }
});

//
// ---------------- PDF ----------------
//

async function loadPDF(file) {
  const reader = new FileReader();

  reader.onload = async function() {
    const typedarray = new Uint8Array(this.result);
    currentPDF = await pdfjsLib.getDocument(typedarray).promise.catch(err => {
      alert("Could not load PDF: " + err.message);
      document.getElementById("uploadScreen").style.display = "block";
      document.getElementById("reader").style.display = "none";
      return null;
    });
    if (!currentPDF) return;

    totalPages = currentPDF.numPages;
    const savedPdfPage = parseInt(localStorage.getItem("savedPage_pdf_" + file.name));
    currentPage = (savedPdfPage && savedPdfPage <= totalPages) ? savedPdfPage : 1;

    document.getElementById("pdfCanvas").style.display = "block";
    document.getElementById("pageInfo").innerText =
      "Page " + currentPage + " of " + totalPages;

    renderPDFPage(currentPage);
  };

  reader.readAsArrayBuffer(file);
}

async function renderPDFPage(pageNum) {
  const page = await currentPDF.getPage(pageNum);
  const canvas = document.getElementById("pdfCanvas");
  const context = canvas.getContext("2d");

  const viewport = page.getViewport({ scale: 1.2 });
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({
    canvasContext: context,
    viewport: viewport
  }).promise;
}

//
// ---------------- EPUB ----------------
function loadEPUB(file) {

  document.getElementById("epubViewer").style.display = "block";
  document.getElementById("pdfCanvas").style.display = "none";

  // Reset state for new book
  detectedCharacters = {};
  characterColors = {};
  characterStyles = {};
  updateCharacterList();

  const savedKey = "savedPage_epub_" + file.name;

  const reader = new FileReader();

  reader.onload = function(e) {

    const book = ePub(e.target.result);

    const viewer = document.getElementById("epubViewer");
    rendition = book.renderTo("epubViewer", {
      manager: "default",
      flow: "paginated",
      spread: "none",
      width: viewer.offsetWidth || window.innerWidth,
      height: viewer.offsetHeight || window.innerHeight - 160
    });

    // Apply current font size
    rendition.themes.fontSize(currentFontSize + "%");

    // Restore saved position for this specific book, else start from beginning
    const savedCfi = localStorage.getItem(savedKey);
    rendition.display(savedCfi || undefined);

    rendition.hooks.content.register(function(contents) {
      let text = contents.document.body.innerText;
      detectCharacters(text);
      updateCharacterList();
      // Always call so all detected names get click handlers (even uncolored ones)
      if (Object.keys(detectedCharacters).length > 0) {
        highlightCharacters(contents);
      }
      // Allow clicking any capitalized word in text to add it as a character
      injectCapitalWordClicker(contents);
      // Re-apply dyslexic font if active
      if (dyslexicFontActive) {
        const style = contents.document.createElement("style");
        style.id = "dyslexic-font-style";
        style.textContent = DYSLEXIC_FONT_CSS;
        contents.document.head.appendChild(style);
      }
    });

    // Generate locations for percentage tracking
    book.ready.then(function() {
      book.locations.generate(1024).then(function() {
        // Update percentage display for current location after generation
        const loc = rendition.currentLocation();
        if (loc && loc.start) {
          const pct = book.locations.percentageFromCfi(loc.start.cfi);
          if (pct != null) {
            document.getElementById("pageInfo").innerText = Math.round(pct * 100) + "% read";
          }
        }
      });
    });

    // Update percentage on each navigation using locations
    rendition.on("relocated", function(location) {
      if (location && location.start) {
        // Try using book.locations if available, else fallback to location.start.percentage
        let pct = null;
        if (book.locations && book.locations.total > 0) {
          pct = book.locations.percentageFromCfi(location.start.cfi);
        } else if (location.start.percentage != null) {
          pct = location.start.percentage;
        }
        document.getElementById("pageInfo").innerText =
          pct != null ? Math.round(pct * 100) + "% read" : "—";
      }
    });

    // Load TOC for chapter navigation
    book.loaded.navigation.then(function(nav) {
      buildChapterList(nav.toc, rendition);
    });

    // Save page button uses per-book key
    document.getElementById("savePageBtn").onclick = function() {
      const location = rendition.currentLocation();
      const cfi = location && location.start && location.start.cfi;
      if (cfi) {
        localStorage.setItem(savedKey, cfi);
        alert("Position saved!");
      }
    };

  };

  reader.readAsArrayBuffer(file);

}

function buildChapterList(toc, rendition) {
  const panel = document.getElementById("chapterPanel");
  const list = document.getElementById("chapterList");
  list.innerHTML = "";

  if (!toc || toc.length === 0) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "block";

  function addItems(items, depth) {
    items.forEach(item => {
      const div = document.createElement("div");
      div.textContent = item.label.trim();
      div.style.paddingLeft = (depth * 12) + "px";
      div.style.cursor = "pointer";
      div.className = "chapter-item";
      div.onclick = () => rendition.display(item.href);
      list.appendChild(div);
      if (item.subitems && item.subitems.length > 0) {
        addItems(item.subitems, depth + 1);
      }
    });
  }

  addItems(toc, 0);
}
//
// ---------------- NAVIGATION ----------------
//

function nextPage() {
  if (currentPDF) {
    if (currentPage < totalPages) {
      currentPage++;
      renderPDFPage(currentPage);
    }
  } else if (rendition) {
    rendition.next();
  }
}

function prevPage() {
  if (currentPDF) {
    if (currentPage > 1) {
      currentPage--;
      renderPDFPage(currentPage);
    }
  } else if (rendition) {
    rendition.prev();
  }
}

//
// ---------------- CHARACTER SYSTEM ----------------
//


document.getElementById("nextBtn").addEventListener("click", nextPage);
document.getElementById("prevBtn").addEventListener("click", prevPage);

window.addEventListener("resize", function() {
  if (rendition) {
    const viewer = document.getElementById("epubViewer");
    rendition.resize(viewer.offsetWidth, viewer.offsetHeight);
  }
});

document.getElementById("settingsBtn").addEventListener("click", function() {
  document.getElementById("settingsPopup").classList.add("open");
});
document.getElementById("settingsClose").addEventListener("click", function() {
  document.getElementById("settingsPopup").classList.remove("open");
});
document.getElementById("settingsPopup").addEventListener("click", function(e) {
  if (e.target === this) this.classList.remove("open");
});

document.getElementById("fontToggleBtn").addEventListener("click", function() {
  dyslexicFontActive = !dyslexicFontActive;
  this.textContent = dyslexicFontActive ? "Switch to Normal Font" : "Switch to OpenDyslexic";

  // Apply only to EPUB iframe content, not the main page UI
  if (rendition) {
    if (dyslexicFontActive) {
      rendition.themes.register("dyslexic", { "body": { "font-family": "OpenDyslexic, sans-serif !important" } });
      rendition.themes.select("dyslexic");
      // Inject @font-face into each iframe
      rendition.getContents().forEach(contents => {
        const style = contents.document.createElement("style");
        style.id = "dyslexic-font-style";
        style.textContent = DYSLEXIC_FONT_CSS;
        contents.document.head.appendChild(style);
      });
    } else {
      rendition.themes.select("default");
      rendition.getContents().forEach(contents => {
        const existing = contents.document.getElementById("dyslexic-font-style");
        if (existing) existing.remove();
      });
    }
  }
});

// Font size slider — applies to EPUB reader content only
let currentFontSize = 100;
document.getElementById("fontSizeSlider").addEventListener("input", function() {
  currentFontSize = parseInt(this.value);
  document.getElementById("fontSizeValue").textContent = currentFontSize + "%";
  if (rendition) {
    rendition.themes.fontSize(currentFontSize + "%");
  }
});

// PDF save page (EPUB save is handled per-book inside loadEPUB)
document.getElementById("savePageBtn").addEventListener("click", function() {
  if (currentPDF) {
    localStorage.setItem("savedPage_pdf_" + (selectedFile ? selectedFile.name : "book"), currentPage);
    alert("Page " + currentPage + " saved!");
  }
});

document.getElementById("saveColor").addEventListener("click", function() {
  if (rendition) {
    rendition.getContents().forEach(contents => {
      highlightCharacters(contents);
    });
  }
});



const NON_NAME_WORDS = new Set([
    // Articles, conjunctions, prepositions
    "The","And","But","For","Yet","Nor","So","Or","An","In","On","At","To","Of","By","As","Up","If","Into","From","With","About","Like",
    // Pronouns
    "He","She","It","We","You","They","His","Her","Its","Our","Your","Their","My","Me","Him","Us","Them","Himself","Herself","Itself","Themselves","Yourself","Ourselves",
    // Demonstratives / interrogatives
    "This","That","These","Those","What","Which","Who","Whom","Whose","When","Where","Why","How","Whether",
    // Quantifiers / determiners
    "All","Any","Each","Every","Few","More","Most","Other","Some","Such","None","Both","Either","Neither","Another","Enough","Several","Many","Much","Less","Least","Any",
    // Negation / modifiers
    "No","Not","Only","Own","Same","Than","Too","Very","Just","Quite","Rather","Almost","Already","Also","Even","Still","Yet","So","Both",
    // Conjunctions (multi-word feel)
    "Because","While","Although","Though","Since","Until","Unless","Whether","After","Before","During","Between","Among","Through","Without","Within","Against","Along","Following","Across","Behind","Beyond","Plus","Except","Despite","Instead","Unless","Whereas","Whereby",
    // Discourse / transition
    "However","Therefore","Moreover","Furthermore","Nevertheless","Meanwhile","Otherwise","Accordingly","Consequently","Indeed","Likewise","Similarly","Hence","Thus","Nonetheless",
    // Book structure
    "Chapter","Part","Section","Volume","Book","Page","Preface","Introduction","Appendix","Index","Contents","Prologue","Epilogue",
    // Numbers (written)
    "One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Hundred","Thousand","Million","Billion",
    // Ordinals
    "First","Second","Third","Fourth","Fifth","Sixth","Seventh","Eighth","Ninth","Tenth","Last","Next","Previous","Former","Latter",
    // Common adjectives
    "New","Old","Good","Great","Little","Long","Big","High","Low","Real","True","False","Hard","Soft","Dark","Light","Young","Small","Large","Full","Empty","Early","Late","Free","Open","Close","Clear","Dark","Bright","Strong","Weak","Fast","Slow","Hot","Cold","Warm","Cool",
    // Common "said" / movement / perception verbs (start-of-sentence style)
    "Said","Told","Asked","Replied","Answered","Thought","Felt","Knew","Saw","Heard","Came","Went","Got","Made","Took","Gave","Seemed","Looked","Turned","Found","Kept","Left","Put","Set","Let","Led","Stood","Walked","Ran","Sat","Lay","Tried","Wanted","Needed","Seemed","Appeared","Became","Remained",
    // Adverbs / time words
    "There","Here","Now","Then","Still","Again","Always","Never","Often","Well","Even","Back","Down","Over","Under","Around","Away","Once","Twice","Often","Soon","Quite","Suddenly","Quickly","Slowly","Simply","Merely","Perhaps","Maybe","Probably","Certainly","Clearly","Truly","Really",
    // Titles / courtesy (won't typically appear alone but just in case)
    "Dear","Please","Sorry","Thank","Yes","Why","Whose","Into","Onto","Upon",
    // Days, months
    "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday","January","February","March","April","May","June","July","August","September","October","November","December"
]);

function detectCharacters(text) {

    let words = text.match(/\b[A-Z][a-z]{2,}\b/g);

    if (!words) return;

    words.forEach(word => {
        if (NON_NAME_WORDS.has(word)) return;

        if (!detectedCharacters[word]) {
            detectedCharacters[word] = 1;
        } else {
            detectedCharacters[word]++;
        }

    });

}

function updateCharacterList() {

    let list = document.getElementById("characterList");
    list.innerHTML = "";

    Object.keys(detectedCharacters)
        .sort((a,b) => detectedCharacters[b] - detectedCharacters[a])
        .slice(0, 20)
        .forEach(name => {

            let div = document.createElement("div");
            const color = characterColors[name];
            // Show a colored dot if the character has a color
            if (color) {
                const dot = document.createElement("span");
                dot.style.display = "inline-block";
                dot.style.width = "10px";
                dot.style.height = "10px";
                dot.style.borderRadius = "50%";
                dot.style.background = color;
                dot.style.marginRight = "5px";
                dot.style.verticalAlign = "middle";
                div.appendChild(dot);
            }
            div.appendChild(document.createTextNode(name));
            // Clicking from list opens the inline color picker near the panel
            div.onclick = function(e) {
                openInlineColorPicker(name, e.clientX, e.clientY);
            };
            list.appendChild(div);

        });

}

function highlightCharacters(contents) {

    let doc = contents.document;

    // Disable browser spell-check underlines inside the epub frame
    if (doc.body) {
        doc.body.setAttribute("spellcheck", "false");
        doc.body.style.webkitSpellCheck = "false";
    }

    // First, strip all existing highlight spans so we don't double-wrap
    doc.querySelectorAll("span[data-char-name]").forEach(span => {
        const text = doc.createTextNode(span.textContent);
        span.parentNode.replaceChild(text, span);
    });
    // Merge adjacent text nodes created by the strip above
    doc.body.normalize();

    // Wrap ALL detected characters (colored or not) so they are always clickable
    const allNames = Object.keys(detectedCharacters);

    allNames.forEach(name => {

        const color = characterColors[name] || null;

        // Collect all matching text nodes BEFORE mutating the DOM
        let walker = doc.createTreeWalker(
            doc.body,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        let matchingNodes = [];
        let node;
        while (node = walker.nextNode()) {
            const nameRegex = new RegExp(`\\b${name}\\b`);
            if (nameRegex.test(node.nodeValue)) {
                matchingNodes.push(node);
            }
        }

        // Now safely replace each collected node
        matchingNodes.forEach(node => {

            let span = doc.createElement("span");
            span.style.cursor = "pointer";
            span.dataset.charName = name;

            const style = characterStyles[name] || "underline";

            if (color) {
                if (style === "solid") {
                    span.style.background = color;
                    span.style.color = "white";
                    span.style.padding = "2px 4px";
                    span.style.borderRadius = "3px";
                } else if (style === "ombre") {
                    // Gradient from transparent (top) to color (bottom) — bottom-to-top fade
                    span.style.backgroundImage = "linear-gradient(to top, " + color + "cc 0%, transparent 100%)";
                    span.style.backgroundRepeat = "no-repeat";
                    span.style.backgroundSize = "100% 100%";
                    span.style.padding = "2px 4px";
                } else {
                    // underline: dashed line in the character's color
                    span.style.borderBottom = "2px dashed " + color;
                    span.style.paddingBottom = "1px";
                }
            } else {
                // Uncolored: no underline
                span.style.borderBottom = "";
                span.style.paddingBottom = "";
            }

            // Split with capture group: even indices = plain text, odd = matched name
            let parts = node.nodeValue.split(new RegExp(`\\b(${name})\\b`));
            let fragment = doc.createDocumentFragment();

            parts.forEach((part, index) => {
                if (index % 2 === 0) {
                    fragment.appendChild(doc.createTextNode(part));
                } else {
                    let s = span.cloneNode(true);
                    s.textContent = part;
                    // Click on name in text → open inline color picker
                    // Translate iframe-relative coords to parent window coords
                    s.addEventListener("click", function(e) {
                        const charName = s.dataset.charName;
                        let absX = e.clientX;
                        let absY = e.clientY;
                        try {
                            // Find the iframe element in the parent that contains this window
                            const iframes = window.parent.document.querySelectorAll("iframe");
                            iframes.forEach(function(iframe) {
                                if (iframe.contentWindow === window) {
                                    const rect = iframe.getBoundingClientRect();
                                    absX = e.clientX + rect.left;
                                    absY = e.clientY + rect.top;
                                }
                            });
                        } catch(err) {}
                        if (window.parent && window.parent.openInlineColorPicker) {
                            window.parent.openInlineColorPicker(charName, absX, absY);
                        } else {
                            openInlineColorPicker(charName, absX, absY);
                        }
                    });
                    fragment.appendChild(s);
                }
            });

            node.parentNode.replaceChild(fragment, node);

        });

    });

}

// ---- Capital word clicker: click any capitalized word to add as character ----

function injectCapitalWordClicker(contents) {
    const doc = contents.document;
    // Remove any old listener to avoid duplicates
    if (doc._capitalClickHandler) {
        doc.removeEventListener("mouseup", doc._capitalClickHandler);
    }

    doc._capitalClickHandler = function(e) {
        // Skip if clicking an already-handled span
        if (e.target && e.target.dataset && e.target.dataset.charName) return;

        // Get word at caret position
        let word = null;
        try {
            let range;
            if (doc.caretRangeFromPoint) {
                range = doc.caretRangeFromPoint(e.clientX, e.clientY);
            } else if (doc.caretPositionFromPoint) {
                const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
                range = doc.createRange();
                range.setStart(pos.offsetNode, pos.offset);
                range.setEnd(pos.offsetNode, pos.offset);
            }
            if (range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
                const text = range.startContainer.nodeValue;
                const offset = range.startOffset;
                // Expand to word boundaries
                let start = offset, end = offset;
                while (start > 0 && /\w/.test(text[start - 1])) start--;
                while (end < text.length && /\w/.test(text[end])) end++;
                word = text.slice(start, end);
            }
        } catch(err) {}

        if (!word) return;
        // Must start with capital, be at least 3 chars, and not already in detectedCharacters
        if (!/^[A-Z][a-z]{2,}$/.test(word)) return;
        if (detectedCharacters[word]) return; // already listed

        // Get absolute coordinates
        let absX = e.clientX, absY = e.clientY;
        try {
            const iframes = window.parent.document.querySelectorAll("iframe");
            iframes.forEach(function(iframe) {
                if (iframe.contentWindow === window) {
                    const rect = iframe.getBoundingClientRect();
                    absX = e.clientX + rect.left;
                    absY = e.clientY + rect.top;
                }
            });
        } catch(err) {}

        // Add to detectedCharacters and open picker
        detectedCharacters[word] = 1;
        updateCharacterList();
        highlightCharacters(contents);
        if (window.parent && window.parent.openInlineColorPicker) {
            window.parent.openInlineColorPicker(word, absX, absY);
        } else {
            openInlineColorPicker(word, absX, absY);
        }
    };

    doc.addEventListener("mouseup", doc._capitalClickHandler);
}

// ---- Inline color picker (click name in text) ----

let inlineTargetChar = null;

window.openInlineColorPicker = function openInlineColorPicker(name, x, y) {
    inlineTargetChar = name;
    const picker = document.getElementById("inlineColorPicker");
    document.getElementById("inlineCharName").textContent = name;
    // Restore existing color
    document.getElementById("inlineColor").value = characterColors[name] || "#ff0000";
    // Restore existing style (none selected if not yet assigned)
    const savedStyle = characterStyles[name] || null;
    document.querySelectorAll('input[name="inlineStyle"]').forEach(function(r) {
        r.checked = savedStyle ? r.value === savedStyle : false;
    });
    // Position popup near the click, keeping it within viewport
    const pw = 220, ph = 200;
    const vw = window.innerWidth, vh = window.innerHeight;
    picker.style.left = Math.min(x + 8, vw - pw) + "px";
    picker.style.top  = Math.min(y + 8, vh - ph) + "px";
    picker.style.display = "block";
};

document.getElementById("inlineApply").addEventListener("click", function() {
    if (!inlineTargetChar) return;
    const color = document.getElementById("inlineColor").value;
    const style = document.querySelector('input[name="inlineStyle"]:checked').value;
    characterColors[inlineTargetChar] = color;
    characterStyles[inlineTargetChar] = style;
    document.getElementById("inlineColorPicker").style.display = "none";
    updateCharacterList(); // refresh dots in the sidebar
    if (rendition) {
        rendition.getContents().forEach(contents => {
            highlightCharacters(contents);
        });
    }
    inlineTargetChar = null;
});

document.getElementById("inlineClose").addEventListener("click", function() {
    document.getElementById("inlineColorPicker").style.display = "none";
    inlineTargetChar = null;
});