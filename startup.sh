#!/bin/bash
# Startup script for AI-Media PDF Q&A application

echo "Starting AI-Media PDF Q&A application..."

echo "Installing server dependencies..."
cd server
npm install

echo "Installing client dependencies..."
cd ../client
npm install

echo "Starting server..."
cd ../server
npm start &
SERVER_PID=$!

echo "Starting client..."
cd ../client
npm start &
CLIENT_PID=$!

echo "Application is running!"
echo "Server at http://localhost:5000"
echo "Client at http://localhost:3000"
echo "Press Ctrl+C to stop"

# Handle Ctrl+C to stop both processes
trap "kill $SERVER_PID $CLIENT_PID; exit" INT
wait 

chmod +x startup.sh 