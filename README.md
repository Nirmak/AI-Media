# AI-Media PDF Q&A

A minimal proof-of-concept application that allows users to view a PDF and ask questions about its content.

## Features

- PDF viewing with basic navigation (previous/next page, direct page jump)
- AI-powered question answering about the PDF content
- No database, authentication, or complex user management
- Single PDF handling (in-memory)

## Project Structure

```
├── client/             # Frontend Express application
│   ├── public/         # Static assets
│   ├── src/            # JavaScript files
│   └── server.js       # Client server
├── server/             # Backend Express/Node.js server
│   └── server.js       # Backend API server
├── public/             # Public assets
│   └── docs/           # PDF files for the application
│       └── sample.pdf  # The sample PDF file
└── README.md           # Project documentation
```

## Setup Instructions

### Prerequisites

- Node.js (v14+ recommended, but works with v12+)
- NPM or Yarn

### Configuration

Before running the application, make sure to:

1. Set your OpenAI API key in `server/.env`:
   ```
   OPENAI_API_KEY=your_openai_api_key_here
   PORT=5000
   PDF_PATH=../public/docs/sample.pdf
   ```

2. Place your PDF file in the `public/docs/` directory (a sample PDF is already included).

### Installation

1. Install server dependencies:
   ```
   cd server
   npm install
   ```

2. Install client dependencies:
   ```
   cd client
   npm install
   ```

### Running the Application

1. Start the server (from the root directory):
   ```
   cd server
   npm start
   ```

2. In a separate terminal, start the client:
   ```
   cd client
   npm start
   ```

3. Access the application at `http://localhost:3000`

## How It Works

1. The server loads the PDF, extracts its text, and provides an API for questions.
2. The frontend displays the PDF using PDF.js and provides a chat interface.
3. When a user asks a question, it's sent to the server API.
4. The server processes the question with OpenAI API and returns an answer based on the PDF content.
5. The answer is displayed in the chat interface.

## Development

Run the servers in development mode with hot reloading:

```
# In the server directory
npm run dev

# In the client directory
npm run dev
```
