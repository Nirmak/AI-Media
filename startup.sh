#!/bin/bash
# Startup script for AI-Media PDF Q&A application

echo "Starting AI-Media PDF Q&A application..."

# Kill previously running instances
echo "Checking for previously running instances..."

# Kill process using port 5000 (server)
SERVER_PID=$(lsof -ti:5000)
if [ -n "$SERVER_PID" ]; then
    echo "Killing server process on port 5000 (PID: $SERVER_PID)..."
    kill -9 $SERVER_PID
fi

# Kill process using port 3000 (client)
CLIENT_PID=$(lsof -ti:3000)
if [ -n "$CLIENT_PID" ]; then
    echo "Killing client process on port 3000 (PID: $CLIENT_PID)..."
    kill -9 $CLIENT_PID
fi

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