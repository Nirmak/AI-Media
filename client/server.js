const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the public directory instead of build
app.use(express.static(path.join(__dirname, 'public')));

// Serve the PDF files from the public/docs directory
app.use('/docs', express.static(path.join(__dirname, '../public/docs')));

// Always return the main index.html for any route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Client server running on port ${PORT}`);
}); 