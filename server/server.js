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
    // This requires 'pdftotext' to be installed on your system (part of poppler-utils)
    exec(`pdftotext "${fullPath}" -`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error extracting text: ${error}`);
        reject(error);
        return;
      }
      currentPdfName = path.basename(pdfPath);
      pdfText = stdout;
      pdfTitle = extractPdfTitle(stdout);
      
      console.log(`PDF loaded successfully: ${currentPdfName}`);
      console.log(`PDF text length: ${pdfText.length} characters`);
      console.log(`PDF title detected: ${pdfTitle}`);
      resolve(stdout);
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
    // Most models can handle ~4000 tokens, which is roughly ~12000-16000 characters
    // Let's aim for 12000 characters from the PDF to be safe
    const maxPdfContentLength = 12000;
    
    // Get document length info for context
    const documentInfo = `Document "${pdfTitle}" (${pdfText.length} characters, using first ${Math.min(maxPdfContentLength, pdfText.length)} for analysis)`;
    
    // Prepare prompt for the AI model with stronger instructions
    const prompt = `
You are an AI assistant discussing the document: "${pdfTitle}".
Your primary job is to accurately answer questions based ONLY on the document content provided below.

IMPORTANT INSTRUCTIONS:
1. Base your answers STRICTLY on the document content provided below.
2. If the answer isn't found in the provided text, clearly state: "I don't find information about this in the document." DO NOT make up or infer information not present in the text.
3. When quoting directly from the document, use ">" markdown formatting.
4. If you need to think through your answer, place your thinking inside <think> </think> tags. This thinking will be hidden from the user.

FORMAT YOUR RESPONSE USING MARKDOWN:
- Use **bold** for emphasis
- Use *italics* for subtle emphasis
- Use ## headings to organize answers
- Use numbered lists for sequences
- Use bullet points for lists of items

${conversationContext ? conversationContext : ''}

DOCUMENT CONTENT:
"""
${pdfText.substring(0, maxPdfContentLength)}
"""

Human question: ${question}

AI:`;

    // Call Ollama API
    const response = await axios.post(OLLAMA_API_URL, {
      model: "deepseek-r1:7b",
      prompt: prompt,
      stream: false
    });

    // Extract the AI's response and process it
    let answer = response.data.response;
    
    // Process the answer to remove thinking parts
    answer = extractFinalAnswer(answer);
    
    return res.json({ answer });
  } catch (error) {
    console.error('Error processing chat request:', error);
    return res.status(500).json({ error: 'Failed to process your question' });
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