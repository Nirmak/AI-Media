const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const PDF_PATH = process.env.PDF_PATH || '../public/docs/sample.pdf';
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434/api/generate';

// Middleware
app.use(cors());
app.use(express.json());

// Store PDF content in memory
let pdfText = '';

// Load and parse PDF on server startup using pdftotext (requires poppler-utils)
const loadPdf = () => {
  return new Promise((resolve, reject) => {
    const pdfPath = path.resolve(__dirname, PDF_PATH);
    // This requires 'pdftotext' to be installed on your system (part of poppler-utils)
    exec(`pdftotext "${pdfPath}" -`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error extracting text: ${error}`);
        reject(error);
        return;
      }
      pdfText = stdout;
      console.log('PDF loaded successfully!');
      console.log(`PDF text length: ${pdfText.length} characters`);
      resolve();
    });
  });
};

// Process model response to remove thinking parts
function extractFinalAnswer(text) {
  // Remove content between <think> and </think> tags
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const question = req.body.question;
    
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }
    
    // Prepare prompt for the AI model
    const prompt = `
You are an AI assistant engaging in a conversation about a PDF document. 
If you need to think through your answer, place your thinking inside <think> </think> tags.
This thinking will be hidden from the user, so make sure your final answer outside these tags is complete.

FORMAT YOUR RESPONSE USING MARKDOWN:
- Use **bold** for emphasis
- Use *italics* for subtle emphasis
- Use ## headings to organize longer answers
- Use numbered lists (1. 2. 3.) for steps or sequences
- Use bullet points for lists of items
- Use \`code\` for technical terms
- Use \`\`\`code blocks\`\`\` for examples
- Use > for quoting text from the document

Here's the content from the document:

${pdfText.substring(0, 8000)}

Question: ${question}

Answer (using Markdown formatting):`;

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
    await loadPdf();
    console.log(`Server running on port ${PORT}`);
  } catch (error) {
    console.error('Failed to start server properly:', error);
  }
}); 