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
const extractPdfTitle = (text) => {
  // Look for potential title patterns in the first few lines
  const lines = text.split('\n').slice(0, 20).filter(line => line.trim() !== '');
  
  // Try to find a line that looks like a title (not too long, possibly capitalized)
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine && 
        trimmedLine.length > 5 && 
        trimmedLine.length < 100 && 
        !trimmedLine.startsWith('http') &&
        !trimmedLine.includes('@') &&
        !trimmedLine.match(/^\d+(\.\d+)+$/)) { // Not just version numbers
      return trimmedLine;
    }
  }
  
  // Fallback to filename if no good title found
  return path.basename(currentPdfName, '.pdf');
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

// Endpoint to list available PDFs
app.get('/api/books', (req, res) => {
  try {
    const files = fs.readdirSync(DOCS_DIR);
    const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
    
    const books = pdfFiles.map(file => ({
      name: file,
      path: `/docs/${file}`,
      current: file === currentPdfName,
      title: file === currentPdfName ? pdfTitle : null
    }));
    
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
      conversationContext = '\nOur conversation so far:\n';
      history.forEach(msg => {
        if (msg.role === 'user') {
          conversationContext += `Human: ${msg.content}\n`;
        } else if (msg.role === 'assistant') {
          conversationContext += `AI: ${msg.content}\n`;
        }
      });
      conversationContext += '\n';
    }
    
    // Prepare prompt for the AI model
    const prompt = `
You are an AI assistant engaging in a conversation about a PDF document titled "${pdfTitle}". 
If you need to think through your answer, place your thinking inside <think> </think> tags.
This thinking will be hidden from the user, so make sure your final answer outside these tags is complete.

${conversationContext ? 'IMPORTANT: You have a memory of our conversation. Refer to it when relevant and don\'t repeat information unnecessarily.' : ''}

FORMAT YOUR RESPONSE USING MARKDOWN:
- Use **bold** for emphasis
- Use *italics* for subtle emphasis
- Use ## headings to organize longer answers
- Use numbered lists (1. 2. 3.) for steps or sequences
- Use bullet points for lists of items
- Use \`code\` for technical terms
- Use \`\`\`code blocks\`\`\` for examples
- Use > for quoting text from the document

Here's the content from the document "${pdfTitle}":

${pdfText.substring(0, 8000)}
${conversationContext}
Human: ${question}

AI (using Markdown formatting):`;

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