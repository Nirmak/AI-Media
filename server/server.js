const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const DOCS_DIR = path.resolve(__dirname, '../public/docs');

// Find first available PDF in docs folder
const findFirstPdf = () => {
  try {
    const files = fs.readdirSync(DOCS_DIR);
    const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
    
    if (pdfFiles.length === 0) {
      throw new Error('No PDF files found in the docs directory');
    }
    
    return path.join('../public/docs', pdfFiles[0]);
  } catch (error) {
    console.error('Error finding PDF files:', error);
    throw error;
  }
};

// Default PDF path - will be set during initialization
let PDF_PATH = '';
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434/api/generate';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Store PDF content in memory
let pdfText = '';
let currentPdfName = '';
let pdfTitle = '';

// Extract the title from PDF content
const extractPdfTitle = (text, filename = currentPdfName) => {
  // Get the first few pages worth of content for analysis
  const firstPageLines = text.split('\n').slice(0, 100).filter(line => line.trim() !== '');
  let candidates = [];
  
  // Look for likely title patterns
  for (let i = 0; i < Math.min(firstPageLines.length, 30); i++) {
    const line = firstPageLines[i].trim();
    
    // Skip obvious non-titles
    if (!line || 
        line.length < 3 || 
        line.length > 120 ||
        line.startsWith('http') ||
        line.startsWith('www.') ||
        line.includes('@') ||
        line.includes('©') ||
        line.includes('copyright') ||
        line.includes('all rights reserved') ||
        line.match(/^\d+(\.\d+)*$/) ||  // Just numbers/versions
        line.match(/^(page|chapter|section)\s+\d+$/i)) { // Page numbers or chapter headers
      continue;
    }
    
    let score = 0;
    
    // Prioritize lines that appear like titles
    if (line === line.toUpperCase() && line.length > 5) {
      score += 10; // All caps is often a title in PDFs
    }
    
    if (line.match(/^[A-Z][^.!?]*$/) && line.length > 10) {
      score += 5; // Starts with capital, no ending punctuation, good length
    }
    
    // Title-like phrases
    if (line.match(/^the\s+[a-z]+/i) || 
        line.match(/^[a-z]+\s+of\s+[a-z]+/i) ||
        line.match(/^[a-z]+\s+and\s+[a-z]+/i)) {
      score += 3;
    }
    
    // Position bonus - titles usually appear early
    score += Math.max(0, 10 - i);
    
    // Add to candidates with score
    candidates.push({ text: line, score, position: i });
  }
  
  // Sort by score (highest first)
  candidates.sort((a, b) => b.score - a.score);
  
  // Try to find specific title patterns if we have enough candidates
  if (candidates.length > 0) {
    // Look for "TITLE" pattern (all caps prominent text)
    const allCapsTitle = candidates.find(c => 
      c.text === c.text.toUpperCase() && 
      c.text.length > 5 &&
      c.text.length < 80 &&
      !/^\d+/.test(c.text) // Not starting with numbers
    );
    
    if (allCapsTitle) {
      console.log(`Found likely title (all caps): "${allCapsTitle.text}"`);
      return allCapsTitle.text;
    }
    
    // Return the highest scoring candidate
    if (candidates[0].score > 5) {
      console.log(`Found likely title (highest score ${candidates[0].score}): "${candidates[0].text}"`);
      return candidates[0].text;
    }
  }
  
  // Extended search - look for specific title keywords in the first 200 lines
  const extendedLines = text.split('\n').slice(0, 200).filter(line => line.trim() !== '');
  for (const line of extendedLines) {
    const trimmed = line.trim();
    if ((trimmed.toLowerCase().includes('title:') || 
         trimmed.match(/^title\s*[:-]/i)) && 
        trimmed.length < 100) {
      const titleParts = trimmed.split(/:\s*/);
      if (titleParts.length > 1) {
        const extractedTitle = titleParts[1].trim();
        console.log(`Found explicit title marker: "${extractedTitle}"`);
        return extractedTitle;
      }
    }
  }
  
  // If all else fails, use filename without extension
  const fallbackTitle = path.basename(filename, '.pdf')
    .replace(/-/g, ' ')
    .replace(/_/g, ' ');
  
  console.log(`No clear title found, using filename: "${fallbackTitle}"`);
  return fallbackTitle;
};

// Load and parse PDF file
const loadPdf = async (pdfPath) => {
  return new Promise((resolve, reject) => {
    const fullPath = path.resolve(__dirname, pdfPath);
    console.log(`Loading PDF from: ${fullPath}`);
    
    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      console.error(`Error: PDF file does not exist at ${fullPath}`);
      reject(new Error(`PDF file not found: ${fullPath}`));
      return;
    }
    
    // Use more reliable pdftotext options for better extraction
    // -layout preserves the layout, -nopgbrk removes page breaks
    const pdfCommand = `pdftotext -layout -nopgbrk "${fullPath}" -`;
    console.log(`Executing command: ${pdfCommand}`);
    
    exec(pdfCommand, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error extracting text: ${error}`);
        if (stderr) {
          console.error(`pdftotext stderr: ${stderr}`);
        }
        reject(error);
        return;
      }
      
      currentPdfName = path.basename(pdfPath);
      
      // Check if we got any content
      if (!stdout || stdout.trim().length === 0) {
        console.error(`Warning: Extracted text is empty for ${fullPath}`);
        pdfText = "The document appears to be empty or could not be properly extracted.";
      } else {
        pdfText = stdout;
      }
      
      // Try to extract a title
      pdfTitle = extractPdfTitle(pdfText);
      
      // Log detailed info for debugging
      console.log(`PDF loaded successfully: ${currentPdfName}`);
      console.log(`PDF text length: ${pdfText.length} characters`);
      console.log(`PDF title detected: ${pdfTitle}`);
      
      // Log a preview of the content
      const contentPreview = pdfText.substring(0, 300).replace(/\n/g, ' ');
      console.log(`Content preview: "${contentPreview}..."`);
      
      resolve(pdfText);
    });
  });
};

// Process model response to remove thinking parts
function extractFinalAnswer(text) {
  // Remove content between <think> and </think> tags
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Extract titles for each PDF without loading the full content
const extractTitleForBook = async (filename) => {
  return new Promise((resolve, reject) => {
    const fullPath = path.join(DOCS_DIR, filename);
    
    // Extract just the first few pages to find the title (faster than full book)
    exec(`pdftotext -f 1 -l 3 "${fullPath}" -`, async (error, stdout, stderr) => {
      if (error) {
        console.error(`Error extracting text for title: ${error}`);
        // Don't reject, just return the filename as fallback
        resolve({
          name: filename,
          title: path.basename(filename, '.pdf').replace(/-/g, ' ').replace(/_/g, ' ')
        });
        return;
      }
      
      // Use the same title extraction logic
      const title = extractPdfTitle(stdout, filename);
      resolve({
        name: filename,
        title: title
      });
    });
  });
};

// Endpoint to list available PDFs
app.get('/api/books', async (req, res) => {
  try {
    const files = fs.readdirSync(DOCS_DIR);
    const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
    
    // Get titles for all books (in parallel)
    const bookPromises = pdfFiles.map(async file => {
      // For the current book, use the cached title
      if (file === currentPdfName) {
        return {
          name: file,
          path: `/docs/${file}`,
          current: true,
          title: pdfTitle
        };
      }
      
      // For other books, extract title
      try {
        const bookInfo = await extractTitleForBook(file);
        return {
          name: file,
          path: `/docs/${file}`,
          current: false,
          title: bookInfo.title
        };
      } catch (error) {
        console.error(`Error extracting title for ${file}:`, error);
        return {
          name: file,
          path: `/docs/${file}`,
          current: false,
          title: file.replace('.pdf', '').replace(/-/g, ' ').replace(/_/g, ' ')
        };
      }
    });
    
    const books = await Promise.all(bookPromises);
    
    res.json({ books });
  } catch (error) {
    console.error('Error listing PDF files:', error);
    res.status(500).json({ error: 'Failed to list PDF files' });
  }
});

// Endpoint to change the current PDF
app.post('/api/books/change', async (req, res) => {
  try {
    const { filename } = req.body;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    
    // Check if file exists
    const fullPath = path.join(DOCS_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Load the new PDF
    await loadPdf(`../public/docs/${filename}`);
    
    res.json({ 
      success: true, 
      message: `Successfully changed to "${filename}"`,
      book: {
        name: filename,
        path: `/docs/${filename}`,
        current: true,
        title: pdfTitle
      }
    });
  } catch (error) {
    console.error('Error changing PDF:', error);
    res.status(500).json({ error: 'Failed to change PDF' });
  }
});

// Endpoint to reload the current PDF
app.post('/api/books/reload', async (req, res) => {
  try {
    if (!currentPdfName) {
      return res.status(400).json({ error: 'No book is currently loaded' });
    }
    
    console.log(`Reloading current PDF: ${currentPdfName}`);
    
    // Reload the current PDF
    await loadPdf(`../public/docs/${currentPdfName}`);
    
    res.json({ 
      success: true, 
      message: `Successfully reloaded "${currentPdfName}"`,
      book: {
        name: currentPdfName,
        path: `/docs/${currentPdfName}`,
        current: true,
        title: pdfTitle,
        contentLength: pdfText.length
      }
    });
  } catch (error) {
    console.error('Error reloading PDF:', error);
    res.status(500).json({ error: 'Failed to reload PDF' });
  }
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { question, history = [] } = req.body;
    
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }
    
    // Format conversation history for the prompt
    let conversationContext = '';
    if (history.length > 0) {
      conversationContext = 'CONVERSATION HISTORY:\n';
      history.forEach(msg => {
        if (msg.role === 'user') {
          conversationContext += `Human: ${msg.content}\n`;
        } else if (msg.role === 'assistant') {
          conversationContext += `AI: ${msg.content}\n`;
        }
      });
      conversationContext += '\n';
    }
    
    // Calculate how much text we can include (try to use more of the document)
    const maxPdfContentLength = 12000;
    
    // Check if we actually have content
    if (!pdfText || pdfText.trim().length === 0) {
      console.error("ERROR: PDF text is empty or not loaded correctly");
      return res.json({ 
        answer: "I apologize, but there appears to be an issue with the document content. It may not have been loaded correctly. Please try reloading the document or selecting a different one." 
      });
    }
    
    // Get a sample of the document for debugging
    const documentPreview = pdfText.substring(0, 300).replace(/\n/g, ' ');
    console.log(`Document preview: "${documentPreview}..."`);
    console.log(`Total document length: ${pdfText.length} characters`);
    
    // Prepare prompt for the AI model with much stronger instructions
    const prompt = `
You are an AI assistant helping with a document titled "${pdfTitle}".
Your sole purpose is to answer questions by finding and quoting SPECIFIC information from the document provided below.

CRITICAL INSTRUCTIONS - YOU MUST FOLLOW THESE EXACTLY:
1. ONLY discuss information explicitly stated in the document. 
2. NEVER invent characters, events, or details not present in the text.
3. When asked about something not in the document, your response MUST be: "I cannot find information about [topic] in the document."
4. ALWAYS support your answers with direct quotes from the document. Use ">" to quote text.
5. NEVER fabricate quotes or information.
6. ALWAYS begin your response by stating whether the information can be found in the document or not.
7. If thinking through your answer, place that inside <think> </think> tags (will be removed).

For questions about characters, plot, events, or any elements:
- Only mention names/elements EXPLICITLY stated in the document
- Do not infer characters if they are not named
- Do not make assumptions about the narrative

${conversationContext ? conversationContext : ''}

DOCUMENT CONTENT:
"""
${pdfText.substring(0, maxPdfContentLength)}
"""

Human question: ${question}

AI:`;

    // Log useful debugging info
    console.log(`Processing question: "${question}"`);
    console.log(`Document stats: ${pdfTitle}, ${pdfText.length} chars, using ${Math.min(pdfText.length, maxPdfContentLength)} chars`);
    
    // Call Ollama API
    console.log("Sending request to Ollama API...");
    const response = await axios.post(OLLAMA_API_URL, {
      model: "deepseek-r1:7b",
      prompt: prompt,
      stream: false
    });

    // Extract the AI's response and process it
    let answer = response.data.response;
    console.log(`Received response of length: ${answer.length} chars`);
    
    // Process the answer to remove thinking parts
    answer = extractFinalAnswer(answer);
    
    return res.json({ answer });
  } catch (error) {
    console.error('Error processing chat request:', error);
    return res.status(500).json({ error: 'Failed to process your question' });
  }
});

// Diagnostic endpoint to check document content
app.get('/api/debug/document', (req, res) => {
  try {
    if (!pdfText || pdfText.trim().length === 0) {
      return res.status(500).json({
        error: 'No document content loaded',
        currentPdf: currentPdfName,
        pdfTitle: pdfTitle
      });
    }
    
    // Get basic stats about the document
    const lines = pdfText.split('\n');
    const nonEmptyLines = lines.filter(line => line.trim().length > 0);
    
    // Return stats and a sample of the content
    return res.json({
      title: pdfTitle,
      filename: currentPdfName,
      totalLength: pdfText.length,
      totalLines: lines.length,
      nonEmptyLines: nonEmptyLines.length,
      sample: pdfText.substring(0, 1000) // First 1000 characters as sample
    });
  } catch (error) {
    console.error('Error in document debug endpoint:', error);
    return res.status(500).json({ error: 'Failed to get document info' });
  }
});

// Extract text from specified page range
const extractPageRangeText = (text, startPage, endPage) => {
  if (!text) return '';
  
  // No longer using page offset, using direct page numbers instead
  const adjustedStartPage = Math.max(1, startPage);
  const adjustedEndPage = Math.max(adjustedStartPage, endPage);
  
  console.log(`Processing page request: ${startPage}-${endPage}`);
  
  // First, try to find page markers in a smarter way
  // Many PDFs include markers like "Page X of Y" or just standalone page numbers
  const lines = text.split('\n');
  const potentialMarkers = [];
  
  // More comprehensive page marker patterns
  const pagePatterns = [
    /^\s*(\d+)\s*$/, // Standalone page number
    /^Page\s*(\d+)(\s+of\s+\d+)?$/i, // "Page X" or "Page X of Y"
    /^\s*-\s*(\d+)\s*-\s*$/, // -X- format
    /^\s*[\[\(]?\s*(\d+)\s*[\]\)]?\s*$/, // [X] or (X) format
    /^\s*[\-\*\•]\s*(\d+)\s*[\-\*\•]\s*$/, // Bullet or dash with number: • X •, * X *, - X -
  ];
  
  // Additional patterns for detecting page boundaries
  const pageBoundaryPatterns = [
    /^chapter\s+\d+/i,
    /^section\s+\d+/i,
    /^part\s+\d+/i,
    /^\d+\.\s+[A-Z]/,  // Numbered sections like "1. Introduction"
    /^[\*\-]{3,}$/     // Divider lines like "***" or "---"
  ];
  
  // Collect all potential page boundaries with their page numbers
  let lineCounter = 0;
  let emptyLineCounter = 0;
  const maxEmptyLines = 3; // Consider a new page after this many consecutive empty lines
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Track empty lines (possible page boundaries)
    if (line === '') {
      emptyLineCounter++;
      if (emptyLineCounter >= maxEmptyLines) {
        // Multiple empty lines often indicate a page break
        potentialMarkers.push({ 
          lineIndex: i - Math.floor(emptyLineCounter/2), 
          pageNum: -1, // Mark as a non-numbered boundary
          confidence: 'low'
        });
        emptyLineCounter = 0;
      }
      continue;
    } else {
      emptyLineCounter = 0;
    }
    
    // Skip very long lines, as they're unlikely to be page markers
    if (line.length > 20) {
      // But first check if it might be a chapter/section header
      for (const pattern of pageBoundaryPatterns) {
        if (line.match(pattern)) {
          potentialMarkers.push({ 
            lineIndex: i, 
            pageNum: -1, // Mark as a non-numbered boundary
            boundary: line.substring(0, 20),
            confidence: 'medium'
          });
          break;
        }
      }
      continue;
    }
    
    // Try each numbered page pattern
    for (const pattern of pagePatterns) {
      const match = line.match(pattern);
      if (match) {
        const pageNum = parseInt(match[1], 10);
        // Only consider reasonable page numbers (ignore false positives)
        if (pageNum > 0 && pageNum < 10000) {
          potentialMarkers.push({ 
            lineIndex: i, 
            pageNum: pageNum,
            confidence: 'high'
          });
          break; // Found a match, no need to check other patterns
        }
      }
    }
  }
  
  // Sort markers by line index
  potentialMarkers.sort((a, b) => a.lineIndex - b.lineIndex);
  
  // Log what we found for debugging
  console.log(`Found ${potentialMarkers.length} potential page markers`);
  if (potentialMarkers.length > 0) {
    console.log(`First 5 markers:`, potentialMarkers.slice(0, 5));
  }
  
  // If we found reasonable markers, use them
  if (potentialMarkers.filter(m => m.pageNum > 0).length > 1) {
    console.log(`Found ${potentialMarkers.filter(m => m.pageNum > 0).length} numbered page markers`);
    
    // Create a mapping of page numbers to line indices
    const pageToLineMap = new Map();
    for (const marker of potentialMarkers) {
      if (marker.pageNum > 0) { // Only use numbered markers for the mapping
        pageToLineMap.set(marker.pageNum, marker.lineIndex);
      }
    }
    
    // Find the closest available page to our requested start and end
    // First, get all available page numbers
    const availablePages = Array.from(pageToLineMap.keys()).sort((a, b) => a - b);
    console.log(`Available page numbers: ${availablePages.slice(0, 10)}${availablePages.length > 10 ? '...' : ''}`);
    
    // Find closest start page (valid page >= requested start page)
    let closestStartPage = availablePages.find(p => p >= adjustedStartPage);
    if (!closestStartPage && availablePages.length > 0) {
      closestStartPage = availablePages[0]; // If no pages >= requested, use first available
    }
    
    // Find closest end page (valid page <= requested end page)
    let closestEndPage = [...availablePages].reverse().find(p => p <= adjustedEndPage);
    if (!closestEndPage && availablePages.length > 0) {
      closestEndPage = availablePages[availablePages.length - 1]; // If no pages <= requested, use last available
    }
    
    // If we have valid start and end pages
    if (closestStartPage !== undefined && closestEndPage !== undefined) {
      // Ensure start doesn't exceed end
      if (closestStartPage > closestEndPage) {
        closestStartPage = closestEndPage;
      }
      
      // Get line indices for these pages
      const startLine = pageToLineMap.get(closestStartPage);
      
      // For end line, we want the line before the next page starts (or end of document)
      const endPageIndex = availablePages.indexOf(closestEndPage);
      let endLine;
      
      if (endPageIndex < availablePages.length - 1) {
        // If not the last page, use the line before the next page starts
        const nextPage = availablePages[endPageIndex + 1];
        endLine = pageToLineMap.get(nextPage) - 1;
      } else {
        // If it's the last page, use the end of the document
        endLine = lines.length - 1;
      }
      
      console.log(`Extracting content from page ${closestStartPage} (line ${startLine}) to page ${closestEndPage} (ending at line ${endLine})`);
      
      // Extract the text between these lines
      const extractedText = lines.slice(startLine, endLine + 1).join('\n');
      
      // Return with detailed extraction info
      return {
        text: extractedText,
        info: {
          method: 'page markers',
          requestedStartPage: startPage,
          requestedEndPage: endPage,
          actualStartPage: closestStartPage,
          actualEndPage: closestEndPage,
          startLine: startLine,
          endLine: endLine,
          charCount: extractedText.length
        }
      };
    }
  }
  
  // Try alternative approach with page boundaries if we have them
  if (potentialMarkers.length > 1) {
    console.log(`Using page boundary markers as fallback`);
    
    // Estimate which markers correspond to our requested pages
    const pageCount = potentialMarkers.length - 1; // Number of "pages" found
    const pageRatio = pageCount / (pdfText.length / 1000); // Pages per 1000 chars
    
    // Calculate the approximate index in the markers array
    const startIndex = Math.max(0, Math.min(Math.floor(adjustedStartPage * pageRatio) - 1, potentialMarkers.length - 2));
    const endIndex = Math.max(startIndex, Math.min(Math.floor(adjustedEndPage * pageRatio), potentialMarkers.length - 1));
    
    // Get start and end lines
    const startLine = potentialMarkers[startIndex].lineIndex;
    const endLine = endIndex < potentialMarkers.length - 1 ? 
                    potentialMarkers[endIndex + 1].lineIndex - 1 : 
                    lines.length - 1;
    
    console.log(`Using boundary markers: start index ${startIndex}, end index ${endIndex}`);
    console.log(`Extracting content from lines ${startLine} to ${endLine}`);
    
    // Extract the text between these lines
    const extractedText = lines.slice(startLine, endLine + 1).join('\n');
    
    // Return with detailed extraction info
    return {
      text: extractedText,
      info: {
        method: 'page boundaries',
        requestedStartPage: startPage,
        requestedEndPage: endPage,
        boundarySections: `${startIndex} to ${endIndex}`,
        startLine: startLine,
        endLine: endLine,
        charCount: extractedText.length
      }
    };
  }
  
  // If we couldn't find good page markers, fall back to estimating pages based on average length
  console.log("Using fallback method: estimating pages based on character count");
  
  // Try to make a better estimate of characters per page based on PDF properties
  // Most PDFs have around 250-500 words per page, with ~5-6 chars per word
  let avgPageLength;
  
  // Calculate a dynamic average based on document length and expected page count
  const estimatedPageCount = Math.max(adjustedEndPage, 20); // Assume at least 20 pages for calculation
  avgPageLength = Math.ceil(pdfText.length / estimatedPageCount);
  
  // Sanity check - keep it in a reasonable range
  if (avgPageLength < 1500) avgPageLength = 1500; // Minimum chars per page
  if (avgPageLength > 4500) avgPageLength = 4500; // Maximum chars per page
  
  console.log(`Using estimated ${avgPageLength} characters per page`);
  
  const totalPages = Math.ceil(pdfText.length / avgPageLength);
  
  // Ensure page range is valid
  const validStartPage = Math.max(1, Math.min(adjustedStartPage, totalPages));
  const validEndPage = Math.max(validStartPage, Math.min(adjustedEndPage, totalPages));
  
  // Calculate character ranges
  const startChar = (validStartPage - 1) * avgPageLength;
  const endChar = Math.min(validEndPage * avgPageLength, pdfText.length);
  
  console.log(`Character-based extraction: Char ${startChar} to ${endChar} for pages ${validStartPage}-${validEndPage}`);
  
  const extractedText = pdfText.substring(startChar, endChar);
  
  // Return with detailed extraction info
  return {
    text: extractedText,
    info: {
      method: 'character count',
      requestedStartPage: startPage,
      requestedEndPage: endPage,
      estimatedStartPage: validStartPage,
      estimatedEndPage: validEndPage,
      charsPerPage: avgPageLength,
      startChar: startChar,
      endChar: endChar,
      charCount: extractedText.length
    }
  };
};

// Endpoint to rewrite text in a different style
app.post('/api/rewrite', async (req, res) => {
  try {
    const { style, startPage, endPage, entireDocument } = req.body;
    
    if (!style) {
      return res.status(400).json({ error: 'Style is required' });
    }
    
    // Check if we have a loaded document
    if (!pdfText || pdfText.trim().length === 0) {
      return res.status(400).json({ 
        error: 'No document content is loaded. Please load a document first.' 
      });
    }
    
    let textToRewrite;
    let extractionInfo = {};
    
    if (entireDocument) {
      // Use the whole document (up to a reasonable limit)
      textToRewrite = pdfText.substring(0, 15000); // Limit to prevent overwhelming the model
      extractionInfo = {
        method: 'entire document (first part)',
        startPage: 1,
        endPage: 'N/A',
        charCount: textToRewrite.length
      };
    } else {
      // Validate page range
      if (!startPage || !endPage || startPage > endPage || startPage < 1) {
        return res.status(400).json({ 
          error: 'Invalid page range. Please provide valid start and end page numbers.' 
        });
      }
      
      // Extract text from the specified page range
      const extractionResult = extractPageRangeText(pdfText, startPage, endPage);
      textToRewrite = extractionResult.text;
      extractionInfo = extractionResult.info;
      
      // Check if we got any content
      if (!textToRewrite || textToRewrite.trim().length === 0) {
        return res.status(400).json({ 
          error: 'No content found in the specified page range.' 
        });
      }
      
      // Limit text length to prevent overwhelming the model
      if (textToRewrite.length > 15000) {
        const originalLength = textToRewrite.length;
        textToRewrite = textToRewrite.substring(0, 15000);
        extractionInfo.truncated = true;
        extractionInfo.originalLength = originalLength;
        extractionInfo.truncatedCharCount = 15000;
      }
    }
    
    // Log extraction info for debugging
    console.log(`Text extraction info:`, extractionInfo);
    
    // Prepare prompt for the rewriting task
    const prompt = `
You are an expert writer tasked with rewriting text in a specific style.

TASK:
Rewrite the following content in a "${style}" style. Maintain the core information and message, 
but adapt the language, tone, vocabulary, and structure to match the requested style.

For reference, here are the characteristics of the requested style:

${style === 'Sci-Fi' ? 
  '- Use futuristic terminology and concepts\n- Include technological or scientific elements\n- Create a sense of wonder or existential questions\n- May include references to advanced technology, space, or future societies' : 
  style === 'Romance' ? 
  '- Use emotive and sensory language\n- Focus on relationships and emotional connections\n- Include more descriptive language about feelings and personal interactions\n- Create a warm, intimate tone' : 
  style === 'Academic' ? 
  '- Use formal, objective language\n- Include relevant terminology and scholarly tone\n- Organize content with clear structure\n- Maintain a detached, analytical perspective\n- Reference concepts methodically' : 
  style === 'Mystery' ?
  '- Create suspense and intrigue\n- Use foreshadowing and subtle hints\n- Include elements of tension and uncertainty\n- Use descriptive language to set the mood' :
  style === 'Children\'s Story' ?
  '- Use simple, clear language\n- Include playful, engaging elements\n- Make concepts accessible for young readers\n- Add a sense of wonder and excitement' :
  '- Adapt to the requested style\n- Maintain core information while changing the presentation\n- Match typical conventions of the genre'}

ORIGINAL TEXT:
"""
${textToRewrite}
"""

REWRITTEN TEXT IN ${style.toUpperCase()} STYLE:`;

    // Call Ollama API
    console.log(`Rewriting text in ${style} style, length: ${textToRewrite.length} chars`);
    const response = await axios.post(OLLAMA_API_URL, {
      model: "deepseek-r1:7b",
      prompt: prompt,
      stream: false
    });

    // Process the response to remove thinking parts
    const rewrittenText = extractFinalAnswer(response.data.response);

    // Return the rewritten text along with extraction info
    return res.json({ 
      original: {
        text: textToRewrite,
        length: textToRewrite.length,
        extractionInfo: extractionInfo
      },
      rewritten: {
        style: style,
        text: rewrittenText,
        length: rewrittenText.length
      } 
    });
  } catch (error) {
    console.error('Error rewriting text:', error);
    return res.status(500).json({ error: 'Failed to rewrite text' });
  }
});

// Endpoint to analyze document structure
app.post('/api/analyze-structure', async (req, res) => {
  try {
    const { bookName } = req.body;
    
    if (!bookName) {
      return res.status(400).json({ error: 'Book name is required' });
    }
    
    // If no current document is loaded or it's a different book than requested
    if (!pdfText || currentPdfName !== bookName) {
      // Try to load the document first
      try {
        await loadPdf(`../public/docs/${bookName}`);
      } catch (error) {
        console.error(`Error loading PDF for structure analysis: ${error}`);
        return res.status(500).json({ error: 'Failed to load the document for analysis' });
      }
    }
    
    console.log(`Analyzing document structure for: ${bookName}`);
    
    // Start analyzing the document structure
    const structure = await analyzeDocumentStructure(pdfText);
    
    return res.json({ 
      success: true,
      bookName: bookName,
      title: pdfTitle,
      structure
    });
  } catch (error) {
    console.error('Error analyzing document structure:', error);
    return res.status(500).json({ error: 'Failed to analyze document structure' });
  }
});

// Function to analyze document structure and split into logical chunks
async function analyzeDocumentStructure(text) {
  const structure = [];
  
  // Split into lines for analysis
  const lines = text.split('\n');
  
  // Pattern matching for chapter/section headings
  const chapterPatterns = [
    /^Chapter\s+(\d+|[IVXLCDM]+)[\s:\-]*(.*)$/i,  // "Chapter 1" or "Chapter I" style
    /^(\d+)\.\s+(.+)$/,  // "1. Introduction" style
    /^([IVXLCDM]+)\.\s+(.+)$/,  // "I. Introduction" style
    /^PART\s+(\d+|[IVXLCDM]+)[\s:\-]*(.*)$/i,  // "PART I" style
    /^SECTION\s+(\d+|[IVXLCDM]+)[\s:\-]*(.*)$/i,  // "SECTION 1" style
    /^(\d+\.\d+)\s+(.+)$/,  // "1.1 Subsection" style
  ];
  
  // Detection of table of contents (TOC)
  let tocIndex = -1;
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    const line = lines[i].trim();
    if (
      line.toLowerCase() === 'table of contents' || 
      line.toLowerCase() === 'contents' || 
      line.toLowerCase() === 'toc'
    ) {
      tocIndex = i;
      break;
    }
  }
  
  // Use TOC to help identify chapters
  const tocChapters = [];
  if (tocIndex !== -1) {
    console.log(`Found potential table of contents at line ${tocIndex}`);
    
    // Scan the next 100 lines after TOC for chapter listings
    for (let i = tocIndex + 1; i < Math.min(lines.length, tocIndex + 100); i++) {
      const line = lines[i].trim();
      if (line === '') continue;
      
      // Check if this looks like a TOC entry (might have page numbers at the end)
      // Pattern: "Chapter X Something........ 10" or "1. Introduction........... 10"
      const tocMatch = line.match(/^(?:Chapter\s+)?(\d+|[IVXLCDM]+)(?:\.|\s+)([^\.0-9]+).*?(\d+)?$/i);
      if (tocMatch) {
        tocChapters.push({
          number: tocMatch[1],
          title: tocMatch[2].trim(),
          page: tocMatch[3] ? parseInt(tocMatch[3]) : null
        });
      }
    }
  }
  
  // Analyze the full document text to identify chapter/section boundaries
  let currentChapter = {
    title: 'Introduction',
    content: []
  };
  
  let chapterStarted = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    let isChapterHeading = false;
    let chapterTitle = '';
    
    // Check if this line matches a chapter/section heading pattern
    for (const pattern of chapterPatterns) {
      const match = line.match(pattern);
      if (match && line.length < 100) {  // Avoid matching normal text that happens to start with numbers
        isChapterHeading = true;
        chapterTitle = match[2] ? `${match[1]}. ${match[2].trim()}` : `Chapter ${match[1]}`;
        break;
      }
    }
    
    // Alternative detection: all caps line with moderate length could be a chapter title
    if (!isChapterHeading && line === line.toUpperCase() && line.length > 3 && line.length < 50) {
      isChapterHeading = true;
      chapterTitle = line;
    }
    
    // Process chapter boundary
    if (isChapterHeading) {
      // If we already have some content, save the current chapter
      if (chapterStarted && currentChapter.content.length > 0) {
        structure.push(currentChapter);
      }
      
      // Start a new chapter
      currentChapter = {
        title: chapterTitle,
        content: []
      };
      chapterStarted = true;
      continue;
    }
    
    // Add the line to the current chapter
    if (line !== '') {
      currentChapter.content.push(line);
    }
  }
  
  // Add the final chapter if it has content
  if (currentChapter.content.length > 0) {
    structure.push(currentChapter);
  }
  
  // Check if we found any chapters - if not, use a fallback approach
  if (structure.length === 0 || (structure.length === 1 && structure[0].title === 'Introduction')) {
    console.log('No clear chapter structure found, using fallback chunking');
    return createFallbackChunks(text);
  }
  
  // Now divide very large chapters into smaller chunks
  const MAX_CHUNK_SIZE = 6000; // characters
  const processedStructure = [];
  
  for (const chapter of structure) {
    // Join chapter content
    const chapterText = chapter.content.join('\n');
    
    // If chapter is small enough, add as is
    if (chapterText.length <= MAX_CHUNK_SIZE) {
      processedStructure.push({
        title: chapter.title,
        text: chapterText
      });
      continue;
    }
    
    // Otherwise, split into logical sub-chunks
    const chunks = splitIntoSubChunks(chapter.content, chapter.title, MAX_CHUNK_SIZE);
    processedStructure.push(...chunks);
  }
  
  console.log(`Document structure analysis complete. Found ${processedStructure.length} logical sections.`);
  
  return processedStructure;
}

// Function to create fallback chunks when no clear chapter structure is detected
function createFallbackChunks(text) {
  const MAX_CHUNK_SIZE = 6000; // characters
  const chunks = [];
  
  // Split text into paragraphs
  const paragraphs = text.split('\n\n').filter(p => p.trim() !== '');
  
  let currentChunk = {
    title: 'Part 1',
    text: ''
  };
  
  let chunkCount = 1;
  
  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed chunk size, start a new chunk
    if (currentChunk.text.length + paragraph.length > MAX_CHUNK_SIZE && currentChunk.text.length > 0) {
      chunks.push(currentChunk);
      chunkCount++;
      currentChunk = {
        title: `Part ${chunkCount}`,
        text: paragraph
      };
    } else {
      // Add paragraph to current chunk
      currentChunk.text += (currentChunk.text ? '\n\n' : '') + paragraph;
    }
  }
  
  // Add the final chunk if it has content
  if (currentChunk.text.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

// Function to split large chapters into logical sub-chunks
function splitIntoSubChunks(contentLines, chapterTitle, maxSize) {
  const chunks = [];
  
  let currentChunk = {
    title: chapterTitle,
    text: ''
  };
  
  let subChunkCount = 1;
  let paragraphs = [];
  let currentParagraph = '';
  
  // First, reconstruct paragraphs from lines
  for (const line of contentLines) {
    if (line.trim() === '') {
      if (currentParagraph) {
        paragraphs.push(currentParagraph);
        currentParagraph = '';
      }
    } else {
      currentParagraph += (currentParagraph ? ' ' : '') + line;
    }
  }
  
  // Add final paragraph if exists
  if (currentParagraph) {
    paragraphs.push(currentParagraph);
  }
  
  // Now process paragraphs into chunks
  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed chunk size, start a new chunk
    if (currentChunk.text.length + paragraph.length > maxSize && currentChunk.text.length > 0) {
      chunks.push(currentChunk);
      subChunkCount++;
      currentChunk = {
        title: `${chapterTitle} (continued ${subChunkCount})`,
        text: paragraph
      };
    } else {
      // Add paragraph to current chunk
      currentChunk.text += (currentChunk.text ? '\n\n' : '') + paragraph;
    }
  }
  
  // Add the final chunk if it has content
  if (currentChunk.text.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

// Streaming rewrite endpoint
app.post('/api/rewrite-stream', async (req, res) => {
  const { style, structure } = req.body;
  
  if (!style) {
    return res.status(400).json({ error: 'Style is required' });
  }
  
  if (!structure || !Array.isArray(structure) || structure.length === 0) {
    return res.status(400).json({ error: 'Valid document structure is required' });
  }
  
  // Set headers for streaming response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  try {
    // Keep track of any active thinking blocks for filtering
    let insideThinkingBlock = false;
    
    // Set up a buffer for handling partial JSON chunks
    let buffer = '';
    let accumulatedText = ''; // To keep track of text when JSON parsing fails
    
    // Process each chunk sequentially
    for (let i = 0; i < structure.length; i++) {
      const chunk = structure[i];
      
      // Signal the start of a new chunk
      res.write(JSON.stringify({
        type: 'chunk_start',
        index: i,
        title: chunk.title,
        total: structure.length
      }));
      
      // Prepare context from previous chunk if available
      let contextPrompt = '';
      if (i > 0) {
        const prevChunk = structure[i-1];
        contextPrompt = `Note: This text follows a previous section titled "${prevChunk.title}". Maintain consistent style with previous sections.\n\n`;
      }
      
      // Prepare prompt for the rewriting task with detailed style guidance
      const prompt = `
You are an expert writer tasked with rewriting text in a specific style.

TASK:
Rewrite the following content in a "${style}" style. Maintain the core information and message, 
but adapt the language, tone, vocabulary, and structure to match the requested style.

IMPORTANT: If you need to think through your approach, place your thinking inside <think></think> tags.
These will be removed from the final output.

${contextPrompt}
This text is from a section titled "${chunk.title}".

For reference, here are the characteristics of the requested style:

${style === 'Sci-Fi' ? 
  '- Use futuristic terminology and concepts\n- Include technological or scientific elements\n- Create a sense of wonder or existential questions\n- May include references to advanced technology, space, or future societies' : 
  style === 'Romance' ? 
  '- Use emotive and sensory language\n- Focus on relationships and emotional connections\n- Include more descriptive language about feelings and personal interactions\n- Create a warm, intimate tone' : 
  style === 'Academic' ? 
  '- Use formal, objective language\n- Include relevant terminology and scholarly tone\n- Organize content with clear structure\n- Maintain a detached, analytical perspective\n- Reference concepts methodically' : 
  style === 'Mystery' ?
  '- Create suspense and intrigue\n- Use foreshadowing and subtle hints\n- Include elements of tension and uncertainty\n- Use descriptive language to set the mood' :
  style === 'Children\'s Story' ?
  '- Use simple, clear language\n- Include playful, engaging elements\n- Make concepts accessible for young readers\n- Add a sense of wonder and excitement' :
  '- Adapt to the requested style\n- Maintain core information while changing the presentation\n- Match typical conventions of the genre'}

ORIGINAL TEXT:
"""
${chunk.text}
"""

Generate a token-by-token rewrite in ${style.toUpperCase()} STYLE:`;

      console.log(`Starting chunk ${i+1}/${structure.length}: ${chunk.title}`);

      // Call Ollama API with response streaming enabled
      const response = await axios.post(OLLAMA_API_URL, {
        model: "deepseek-r1:7b",
        prompt: prompt,
        stream: true
      }, {
        responseType: 'stream'
      });
      
      // Process the streaming response
      response.data.on('data', (chunk) => {
        try {
          // Add to the buffer
          const chunkStr = chunk.toString();
          buffer += chunkStr;
          
          // Try to extract complete JSON objects from the buffer
          let startIndex = 0;
          let endIndex;
          let nextStartIndex;
          let jsonObjectFound = false;
          
          while ((endIndex = buffer.indexOf('}\n', startIndex)) !== -1) {
            // Extract a complete JSON object
            const jsonStr = buffer.substring(startIndex, endIndex + 1);
            nextStartIndex = endIndex + 2; // Skip the '}\n'
            
            try {
              // Parse the complete JSON object
              const data = JSON.parse(jsonStr);
              jsonObjectFound = true;
              
              if (data.response) {
                // Get the token to send
                let token = data.response;
                
                // Check for thinking tags and filter content in real-time
                if (token.includes('<think>')) {
                  // Start of thinking block
                  insideThinkingBlock = true;
                  token = token.split('<think>')[0]; // Keep text before <think>
                }
                
                if (token.includes('</think>')) {
                  // End of thinking block
                  insideThinkingBlock = false;
                  token = token.split('</think>')[1] || ''; // Keep text after </think>
                }
                
                // Only send tokens that are not inside thinking blocks
                if (!insideThinkingBlock && token) {
                  // Send each token to the client
                  res.write(JSON.stringify({
                    type: 'token',
                    text: token
                  }));
                  
                  // Also update accumulated text
                  accumulatedText += token;
                }
              }
            } catch (e) {
              // If we can't parse this chunk, it might be due to stream splitting in the middle of a JSON object
              // Just continue with the next chunk, the buffer will accumulate more data
              console.log(`Skipping invalid JSON chunk: ${jsonStr.substring(0, 40)}...`);
            }
            
            startIndex = nextStartIndex;
          }
          
          // Keep any incomplete part in the buffer for the next data chunk
          buffer = buffer.substring(startIndex);
          
          // Fallback: If no JSON objects were found, try to extract plain text content
          // This handles cases where Ollama might not be sending proper JSON format
          if (!jsonObjectFound && chunkStr.trim() && !chunkStr.includes('"response"')) {
            // First, try to extract any text content that might be direct model output
            // Filter out thinking blocks
            let plainText = chunkStr;
            
            if (plainText.includes('<think>')) {
              insideThinkingBlock = true;
              plainText = plainText.split('<think>')[0]; // Keep text before <think>
            }
            
            if (plainText.includes('</think>')) {
              insideThinkingBlock = false;
              plainText = plainText.split('</think>')[1] || ''; // Keep text after </think>
            }
            
            // Only send text that is not inside thinking blocks
            if (!insideThinkingBlock && plainText.trim()) {
              console.log('Using fallback text extraction');
              // Send the text as a token
              res.write(JSON.stringify({
                type: 'token',
                text: plainText
              }));
              
              // Also update accumulated text
              accumulatedText += plainText;
            }
          }
        } catch (error) {
          console.error('Error processing chunk in stream:', error);
          // Don't rethrow - we want to keep the stream going even if one chunk fails
        }
      });
      
      // Wait for the stream to complete
      await new Promise((resolve, reject) => {
        response.data.on('end', () => {
          console.log(`Finished chunk ${i+1}/${structure.length}`);
          resolve();
        });
        
        response.data.on('error', (err) => {
          console.error(`Error in chunk ${i+1}:`, err);
          reject(err);
        });
      });
      
      // Reset thinking block tracking at the end of each chunk
      insideThinkingBlock = false;
      
      // Add a separator between chunks
      res.write(JSON.stringify({
        type: 'token',
        text: '\n\n'
      }));
    }
    
    console.log('All chunks completed successfully');
    
    // End the response stream
    res.end();
    
  } catch (error) {
    console.error('Error in streaming rewrite:', error);
    
    // If we haven't sent headers yet, send a JSON error
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to process document rewrite' });
    }
    
    // Otherwise, send an error in the stream format
    try {
      res.write(JSON.stringify({ 
        type: 'error', 
        message: 'Error processing document rewrite: ' + error.message
      }));
      res.end();
    } catch (e) {
      res.end();
    }
  }
});

// Start server
app.listen(PORT, async () => {
  try {
    // Find and load the first available PDF
    PDF_PATH = findFirstPdf();
    await loadPdf(PDF_PATH);
    console.log(`Server running on port ${PORT}`);
  } catch (error) {
    console.error('Failed to start server properly:', error);
  }
}); 