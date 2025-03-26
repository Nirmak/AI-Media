// Chat elements
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');

// API URL (adjust if needed)
const API_URL = 'http://localhost:5000/api';

/**
 * Add a message to the chat container
 */
function addMessage(text, isUser = false) {
  const messageElement = document.createElement('div');
  messageElement.className = isUser ? 'user-message' : 'ai-message';
  messageElement.textContent = text;
  
  chatMessages.appendChild(messageElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Add a loading indicator
 */
function addLoadingIndicator() {
  const loadingElement = document.createElement('div');
  loadingElement.className = 'ai-message loading';
  loadingElement.innerHTML = 'Thinking<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>';
  loadingElement.id = 'loading-indicator';
  
  chatMessages.appendChild(loadingElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Remove the loading indicator
 */
function removeLoadingIndicator() {
  const loadingElement = document.getElementById('loading-indicator');
  if (loadingElement) {
    loadingElement.remove();
  }
}

/**
 * Send a message to the API and get a response
 */
async function sendMessageToAPI(question) {
  try {
    addLoadingIndicator();
    
    const response = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    removeLoadingIndicator();
    
    // Add the AI's response to the chat
    addMessage(data.answer, false);
  } catch (error) {
    console.error('Error communicating with API:', error);
    removeLoadingIndicator();
    addMessage('Sorry, I had trouble processing your question. Please try again.', false);
  }
}

/**
 * Handle sending a message
 */
function handleSendMessage() {
  const message = chatInput.value.trim();
  
  if (!message) {
    return;
  }
  
  // Add the user's message to the chat
  addMessage(message, true);
  
  // Clear the input field
  chatInput.value = '';
  
  // Send the message to the API
  sendMessageToAPI(message);
}

// Event listeners
sendButton.addEventListener('click', handleSendMessage);
chatInput.addEventListener('keypress', function(e) {
  if (e.key === 'Enter') {
    handleSendMessage();
  }
}); 