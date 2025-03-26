// Main application script
document.addEventListener('DOMContentLoaded', function() {
  console.log('AI-Media PDF Q&A application initialized');
  
  // Update loading style for animated dots
  const style = document.createElement('style');
  style.textContent = `
    .loading .dot {
      animation: dotFading 1.5s infinite;
      opacity: 0;
    }
    
    .loading .dot:nth-child(1) {
      animation-delay: 0s;
    }
    
    .loading .dot:nth-child(2) {
      animation-delay: 0.5s;
    }
    
    .loading .dot:nth-child(3) {
      animation-delay: 1s;
    }
    
    @keyframes dotFading {
      0%, 100% {
        opacity: 0;
      }
      50% {
        opacity: 1;
      }
    }
  `;
  
  document.head.appendChild(style);
}); 