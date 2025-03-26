// PDF.js variables
let pdfDoc = null;
let pageNum = 1;
let pageRendering = false;
let pageNumPending = null;
let scale = 1.5;
const canvas = document.getElementById('pdf-viewer');
const ctx = canvas.getContext('2d');

// PDF.js is included from CDN in the HTML file
const pdfjsLib = window['pdfjs-dist/build/pdf'];

// The workerSrc property needs to be specified
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://mozilla.github.io/pdf.js/build/pdf.worker.js';

/**
 * Get page info from document, resize canvas accordingly, and render page.
 * @param num Page number.
 */
function renderPage(num) {
  pageRendering = true;
  
  // Using promise to fetch the page
  pdfDoc.getPage(num).then(function(page) {
    const viewport = page.getViewport({ scale: scale });
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    
    // Render PDF page into canvas context
    const renderContext = {
      canvasContext: ctx,
      viewport: viewport
    };
    
    const renderTask = page.render(renderContext);
    
    // Wait for rendering to finish
    renderTask.promise.then(function() {
      pageRendering = false;
      
      if (pageNumPending !== null) {
        // New page rendering is pending
        renderPage(pageNumPending);
        pageNumPending = null;
      }
    });
  });
  
  // Update page counters
  document.getElementById('page-num').textContent = num;
}

/**
 * If another page rendering in progress, wait until the rendering is
 * finished. Otherwise, execute rendering immediately.
 */
function queueRenderPage(num) {
  if (pageRendering) {
    pageNumPending = num;
  } else {
    renderPage(num);
  }
}

/**
 * Displays previous page.
 */
function onPrevPage() {
  if (pageNum <= 1) {
    return;
  }
  pageNum--;
  queueRenderPage(pageNum);
}

/**
 * Displays next page.
 */
function onNextPage() {
  if (pageNum >= pdfDoc.numPages) {
    return;
  }
  pageNum++;
  queueRenderPage(pageNum);
}

/**
 * Go to specific page.
 */
function onGoToPage() {
  const input = document.getElementById('page-input');
  const pageNumber = parseInt(input.value, 10);
  
  if (isNaN(pageNumber)) {
    return;
  }
  
  if (pageNumber < 1 || pageNumber > pdfDoc.numPages) {
    alert(`Valid page numbers are 1 to ${pdfDoc.numPages}`);
    return;
  }
  
  pageNum = pageNumber;
  queueRenderPage(pageNum);
}

/**
 * Load and initialize the PDF.
 */
function initPdf() {
  const url = '/docs/sample.pdf';
  
  // Asynchronously download PDF
  pdfjsLib.getDocument(url).promise.then(function(pdfDoc_) {
    pdfDoc = pdfDoc_;
    document.getElementById('page-count').textContent = pdfDoc.numPages;
    
    // Initial/first page rendering
    renderPage(pageNum);
  }).catch(function(error) {
    console.error('Error loading PDF:', error);
    const errorMessage = document.createElement('div');
    errorMessage.className = 'error-message';
    errorMessage.textContent = 'Error loading PDF. Please check the console for details.';
    document.querySelector('.pdf-container').appendChild(errorMessage);
  });
}

// Event listeners
document.getElementById('prev-page').addEventListener('click', onPrevPage);
document.getElementById('next-page').addEventListener('click', onNextPage);
document.getElementById('go-to-page').addEventListener('click', onGoToPage);
document.getElementById('page-input').addEventListener('keypress', function(e) {
  if (e.key === 'Enter') {
    onGoToPage();
  }
});

// Initialize the PDF viewer when the page is loaded
window.addEventListener('load', initPdf); 