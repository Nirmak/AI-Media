const express = require('express');
const cors = require('cors');
const path = require('path');
const logger = require('./logger');
const config = require('./config/config');
const pdfController = require('./controllers/pdfController');
const bookService = require('./services/bookService');
const axios = require('axios');

// Ollama API URL
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:7b';

// Import routes
const pdfRoutes = require('./routes/pdfRoutes');
const chatRoutes = require('./routes/chatRoutes');
const bookRoutes = require('./routes/bookRoutes');
const booksCompatibilityRoutes = require('./routes/booksCompatibilityRoutes');

// Initialize express app
const app = express();
const PORT = config.server.port;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Log all requests
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`);
  
  // Log request details
  logger.info(`[REQUEST] Headers: ${JSON.stringify(req.headers)}`);
  if (req.body && Object.keys(req.body).length > 0) {
    logger.info(`[REQUEST] Body: ${JSON.stringify(req.body)}`);
  }
  
  // Log response
  const originalSend = res.send;
  res.send = function(body) {
    // Log first 1000 chars of response to avoid massive logs
    const truncatedBody = typeof body === 'string' ? body.substring(0, 1000) : JSON.stringify(body).substring(0, 1000);
    logger.info(`[RESPONSE] Status: ${res.statusCode}, Body: ${truncatedBody}${truncatedBody.length === 1000 ? '...(truncated)' : ''}`);
    
    // Call the original send function
    return originalSend.call(this, body);
  };
  
  next();
});

// API Routes
app.use('/api/pdf', pdfRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/book', bookRoutes);

// Full compatibility layer for /api/books
app.use('/api/books', booksCompatibilityRoutes);

// Creative Rewrite endpoint
app.get('/api/creative-rewrite', async (req, res) => {
  const { genre } = req.query;
  
  logger.info(`Creative rewrite request received for genre: "${genre}"`);

  // --- Pre-computation checks ---
  if (!genre) {
      return res.status(400).json({ error: 'Genre parameter is required' });
  }
  
  // Get current PDF info
  const currentPdfInfo = pdfController.getCurrentPdfInfo();
  if (!currentPdfInfo || !currentPdfInfo.filename) {
      logger.warn('Rewrite requested, but no book is loaded or selected.');
      // Send SSE error message
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify({ error: 'No book selected. Please select a book first.' })}\n\n`);
      return res.end();
  }
  
  const analysisResults = bookService.getAnalysisResults(currentPdfInfo.filename);
  
  if (!analysisResults || analysisResults.status !== 'completed') {
      logger.warn('Rewrite requested, but analysis is not completed for the current book.');
      // Send SSE error message
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify({ error: 'Book analysis is not complete. Please run the analysis first.' })}\n\n`);
      return res.end();
  }
  
  // --- Construct the prompt ---
  let prompt = `You are a creative writer tasked with generating a short story (around 3-5 paragraphs long) based on the analysis of a book. \nIf you need to think, put your thoughts in <think></think> tags. This thinking will be hidden. Your final story should be outside these tags.\n\n`;
  prompt += `**Target Genre/Style:** ${genre}\n\n`;
  prompt += `**Source Book:** ${currentPdfInfo.title || currentPdfInfo.filename}\n\n`;
  prompt += `**Core Message/Intent to Convey (Mandatory):**\n${analysisResults.analysis.intent || analysisResults.analysis.plotSummary || 'Focus on the main themes.'}\n\n`;
  
  if (analysisResults.analysis.themes && analysisResults.analysis.themes.length > 0) {
      prompt += `**Key Themes to Weave In:**\n${analysisResults.analysis.themes.map(t => `- ${t.name}: ${t.description || ''}`).join('\n')}\n\n`;
  }
  
  if (analysisResults.analysis.mainCharacters && analysisResults.analysis.mainCharacters.length > 0) {
      prompt += `**Characters for Inspiration (Adapt Freely):**\n${analysisResults.analysis.mainCharacters.map(c => `- ${c.name}: ${c.description || ''} (Role: ${c.role || 'N/A'})`).join('\n')}\n\n`;
  }
  
  prompt += `**Instructions:** Write a compelling short story in the **${genre}** style that embodies the core message/intent and incorporates the themes mentioned above. You can adapt the characters for the new genre. Format your response using Markdown.\n\n**BEGIN STORY:**\n`;

  // --- Setup SSE ---  
  res.writeHead(200, { 
      'Content-Type': 'text/event-stream', 
      'Cache-Control': 'no-cache', 
      'Connection': 'keep-alive' 
  });

  // --- Call Ollama API and Stream Response ---
  let fullResponse = '';
  let buffer = ''; // Buffer for incoming chunks
  let isThinking = false;
  let responseBuffer = ''; // Buffer for content to be streamed

  try {
    const response = await axios.post(OLLAMA_API_URL, {
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: true
    }, {
      responseType: 'stream',
      timeout: 60000 // 60 second timeout for the API call
    });

    response.data.on('data', (chunk) => {
      try {
        buffer += chunk.toString();
        let newlineIndex;

        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, newlineIndex).trim();
            buffer = buffer.substring(newlineIndex + 1);

            if (!line) continue;

            try {
                const data = JSON.parse(line);

                if (data.response) {
                    responseBuffer += data.response; // Add raw response to buffer

                    // Handle thinking blocks
                    if (responseBuffer.includes('<think>')) {
                        isThinking = true;
                    }

                    if (isThinking) {
                        if (responseBuffer.includes('</think>')) {
                            isThinking = false;
                            // Remove the completed thinking block and any content before it
                            responseBuffer = responseBuffer.replace(/.*?<think>[\s\S]*?<\/think>/gs, '').trimStart();
                        }
                    } else if (responseBuffer) {
                         // If not thinking, send the buffered content
                         const chunkToSend = responseBuffer;
                         responseBuffer = ''; // Clear buffer after sending
                         fullResponse += chunkToSend;
                         if (!res.writableEnded) {
                             res.write(`data: ${JSON.stringify({ chunk: chunkToSend })}\n\n`);
                         }
                    }
                }
                
                // Handle final chunk
                 if (data.done) {
                    // Send any remaining content in the buffer (after potentially removing final thought tags)
                    if (responseBuffer) {
                         const finalChunk = responseBuffer.replace(/<think>[\s\S]*?<\/think>/gs, '').trim();
                         if (finalChunk && !res.writableEnded) {
                            fullResponse += finalChunk;
                            res.write(`data: ${JSON.stringify({ chunk: finalChunk })}\n\n`);
                         }
                    }
                    
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                        logger.llm('Creative Rewrite (Streaming)', fullResponse);
                        res.end();
                    }
                    return; // Exit processing loop
                }

            } catch (parseError) {
                 logger.error('Rewrite: Error parsing JSON line:', parseError, 'Line:', line);
                 // Optionally try to fix JSON if needed, or just continue
                 continue; 
            }
        }
      } catch (chunkProcessingError) {
        logger.error('Rewrite: Error processing chunk:', chunkProcessingError);
        if (!res.writableEnded) {
            try {
                res.write(`data: ${JSON.stringify({ error: 'Error processing rewrite data chunk.' })}\n\n`);
                res.end();
            } catch (writeError) {
                logger.error('Rewrite: Error writing error chunk:', writeError);
            }
        }
      }
    });

    response.data.on('error', (streamError) => {
      logger.error('Rewrite: Ollama stream error:', streamError);
      if (!res.writableEnded) {
          try{
            res.write(`data: ${JSON.stringify({ error: 'Error during rewrite generation stream.' })}\n\n`);
            res.end();
          } catch (writeError) {
            logger.error('Rewrite: Error writing stream error:', writeError);
          }
      }
    });

    response.data.on('end', () => {
      logger.info('Rewrite: Ollama stream ended.');
      if (!res.writableEnded) {
          // Ensure the done event is sent if the stream ends unexpectedly
          try {
             res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
             res.end();
          } catch (writeError) {
             logger.error('Rewrite: Error writing end event:', writeError);
          }
      }
    });

  } catch (error) {
    logger.error('Rewrite: Failed to call Ollama API:', error);
     if (!res.headersSent) { // If headers haven't been sent, send a standard HTTP error
         res.status(500).json({ error: 'Failed to generate rewrite', details: error.message });
     } else if (!res.writableEnded) { // Otherwise, try to send an SSE error
         try {
            res.write(`data: ${JSON.stringify({ error: `Failed to start rewrite generation: ${error.message}` })}\n\n`);
            res.end();
         } catch (writeError) {
            logger.error('Rewrite: Error writing API call error:', writeError);
         }
     }
  }
});

// Home route
app.get('/', (req, res) => {
  res.json({ message: 'AI-Media PDF Q&A API' });
});

// Catch-all for 404s
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(`Error: ${err.message}`);
  res.status(500).json({ error: 'Server error', message: err.message });
});

// Start server
app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  
  try {
    // Load the default PDF on startup using an absolute path
    const pdfPath = path.resolve(__dirname, '../public/docs/Book-Romance.pdf');
    await pdfController.loadPdf(pdfPath);
    logger.info(`Loaded PDF: ${pdfController.getCurrentPdfInfo().title}`);
  } catch (error) {
    logger.error('Failed to load initial PDF:', error);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Don't exit the process
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process
}); 