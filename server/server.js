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
app.use(express.json());

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
  
  // Simple heuristic to identify page breaks in the PDF text
  // This is a basic approach - more sophisticated methods might be needed for complex PDFs
  const pageMarkers = [];
  const lines = text.split('\n');
  
  // Find page number markers in the text
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Look for standalone page numbers or common page markers
    if (
      (line.match(/^\d+$/) && line.length < 5) || // Standalone page number
      line.match(/^Page\s+\d+(\s+of\s+\d+)?$/i) || // "Page X" or "Page X of Y"
      line.match(/^\d+\s*\|\s*Page$/) // Page marker with separator
    ) {
      pageMarkers.push(i);
    }
  }
  
  // If we can't find page markers, try to estimate pages based on average page length
  if (pageMarkers.length < 2) {
    const avgPageLength = 3000; // Rough estimate: 3000 characters per page
    const totalPages = Math.ceil(text.length / avgPageLength);
    
    // Ensure page range is valid
    const validStartPage = Math.max(1, Math.min(startPage, totalPages));
    const validEndPage = Math.max(validStartPage, Math.min(endPage, totalPages));
    
    // Calculate character ranges
    const startChar = (validStartPage - 1) * avgPageLength;
    const endChar = Math.min(validEndPage * avgPageLength, text.length);
    
    return text.substring(startChar, endChar);
  }
  
  // Use identified page markers to extract the page range
  // Ensure page range is valid
  const validStartPage = Math.max(1, Math.min(startPage, pageMarkers.length));
  const validEndPage = Math.max(validStartPage, Math.min(endPage, pageMarkers.length));
  
  // Get the start and end line indices
  let startLine = validStartPage === 1 ? 0 : pageMarkers[validStartPage - 2] + 1;
  let endLine = pageMarkers[validEndPage - 1] || lines.length;
  
  // Extract the text between those lines
  return lines.slice(startLine, endLine).join('\n');
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
    
    if (entireDocument) {
      // Use the whole document (up to a reasonable limit)
      textToRewrite = pdfText.substring(0, 15000); // Limit to prevent overwhelming the model
    } else {
      // Validate page range
      if (!startPage || !endPage || startPage > endPage || startPage < 1) {
        return res.status(400).json({ 
          error: 'Invalid page range. Please provide valid start and end page numbers.' 
        });
      }
      
      // Extract text from the specified page range
      textToRewrite = extractPageRangeText(pdfText, startPage, endPage);
      
      // Check if we got any content
      if (!textToRewrite || textToRewrite.trim().length === 0) {
        return res.status(400).json({ 
          error: 'No content found in the specified page range.' 
        });
      }
      
      // Limit text length to prevent overwhelming the model
      if (textToRewrite.length > 15000) {
        textToRewrite = textToRewrite.substring(0, 15000);
      }
    }
    
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

    // Return the rewritten text
    return res.json({ 
      original: {
        text: textToRewrite,
        length: textToRewrite.length
      },
      rewritten: {
        style: style,
        text: response.data.response,
        length: response.data.response.length
      } 
    });
  } catch (error) {
    console.error('Error rewriting text:', error);
    return res.status(500).json({ error: 'Failed to rewrite text' });
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