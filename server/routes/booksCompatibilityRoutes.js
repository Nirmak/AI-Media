/**
 * Simple compatibility router for /api/books endpoints
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const pdfController = require('../controllers/pdfController');
const logger = require('../logger');
const bookService = require('../services/bookService');
const axios = require('axios');

// Ollama API URL (same as in server.js.bak)
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:7b';

// GET /api/books - List all books
router.get('/', async (req, res) => {
  try {
    const pdfs = await pdfController.listAvailablePdfs();
    
    // Format the response to match what the client expects
    const books = pdfs.map(pdf => ({
      name: pdf.filename,
      title: pdf.title,
      path: pdf.path,
      current: pdf.filename === pdfController.getCurrentPdfInfo().filename
    }));
    
    res.json({ books });
  } catch (error) {
    logger.error('Error listing books:', error);
    res.status(500).json({ error: 'Failed to list available books' });
  }
});

// POST /api/books/change - Change current book
router.post('/change', async (req, res) => {
  try {
    const { filename } = req.body;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    
    try {
      // Use path.resolve for more reliable path handling
      const pdfPath = path.resolve(__dirname, '../../public/docs', filename);
      await pdfController.loadPdf(pdfPath);
      const info = pdfController.getCurrentPdfInfo();
      
      res.json({ 
        success: true, 
        message: 'Book changed successfully',
        book: {
          name: info.filename,
          title: info.title,
          path: `/docs/${info.filename}`,
          current: true
        }
      });
    } catch (loadError) {
      logger.error(`Error loading PDF ${filename}:`, loadError);
      res.status(404).json({ success: false, error: 'Not found' });
    }
  } catch (error) {
    logger.error('Error changing book:', error);
    res.status(500).json({ success: false, error: 'Failed to change book' });
  }
});

// GET /api/books/:filename/analysis - Get analysis for a specific book
router.get('/:filename/analysis', async (req, res) => {
  try {
    const { filename } = req.params;
    logger.info(`Getting analysis for book: ${filename}`);
    
    // Get the book analysis
    const bookAnalysis = bookService.getBookAnalysis(filename);
    
    if (!bookAnalysis) {
      logger.info(`Book analysis not found for ${filename}`);
      return res.status(404).json({ error: 'Not found' });
    }
    
    // Return the analysis results
    const analysisResults = bookService.getAnalysisResults(filename);
    if (!analysisResults) {
      logger.info(`Analysis results not available for ${filename}`);
      return res.status(202).json({ 
        status: 'pending',
        message: 'Analysis is not yet completed',
        progress: bookAnalysis.analysisStatus
      });
    }
    
    res.json(analysisResults);
  } catch (error) {
    logger.error(`Error retrieving book analysis for ${req.params.filename}:`, error);
    res.status(500).json({ error: 'Failed to retrieve book analysis' });
  }
});

// POST /api/books/:filename/analyze - Start analysis for a specific book
router.post('/:filename/analyze', async (req, res) => {
  try {
    const { filename } = req.params;
    const options = req.body.options || {};
    
    logger.info(`Starting analysis for book: ${filename} with options:`, options);
    
    // Check if book exists
    const bookAnalysis = bookService.getBookAnalysis(filename);
    if (!bookAnalysis) {
      logger.error(`Book not found for analysis: ${filename}`);
      return res.status(404).json({ error: 'Not found' });
    }
    
    // Start the analysis in the background
    bookService.analyzeBook(filename, options)
      .then(() => {
        logger.info(`Analysis completed for book: ${filename}`);
      })
      .catch(err => {
        logger.error(`Analysis failed for book ${filename}:`, err);
      });
    
    // Return immediate response
    res.json({
      status: 'started',
      message: 'Analysis has been started',
      bookId: filename,
      progress: bookAnalysis.analysisStatus
    });
  } catch (error) {
    logger.error(`Error starting book analysis for ${req.params.filename}:`, error);
    res.status(500).json({ error: 'Failed to start book analysis' });
  }
});

module.exports = router; 