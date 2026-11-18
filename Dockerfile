# Use official Node.js runtime as parent image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the TypeScript code
RUN npm run build

# Set environment variables (can be overridden at runtime)
ENV SAC_BASE_URL=""
ENV SAC_TOKEN_URL=""
ENV SAC_CLIENT_ID=""
ENV SAC_CLIENT_SECRET=""
ENV SAC_REDIRECT_URI="http://localhost:8765/callback"
# Browser SSO sign-in listens on loopback inside the process, so it only
# works when the server runs natively next to a browser, not in this container.

# Start the server
CMD ["node", "build/index.js"]
