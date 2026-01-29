# Contributing to Heuristic MCP

Thank you for your interest in contributing. This document provides guidelines for contributing to the project.

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm or yarn
- Git

### Setup Development Environment

```bash
# Fork and clone the repository
git clone https://github.com/softerist/heuristic-mcp.git
cd heuristic-mcp

# Install dependencies
npm install

# Run in development mode
npm run dev
```

## Project Structure

See `ARCHITECTURE.md` for detailed information about the modular architecture.

Key directories:

- `lib/` - Core libraries and utilities
- `features/` - Pluggable feature modules
- `scripts/` - Utility scripts
- `tools/` - Developer-only helpers

## Development Guidelines

### Code Style

- Use ES6+ JavaScript features
- Follow existing code patterns
- Use meaningful variable and function names
- Add comments for complex logic
- Avoid emojis in code comments and logs unless they are part of user-facing CLI output

### File Organization

```javascript
// Standard file structure for features:

// 1. Imports
import { dependency } from 'package';

// 2. Class definition
export class FeatureName {
  constructor(embedder, cache, config) {
    // ...
  }

  async method() {
    // ...
  }
}

// 3. MCP tool definition
export function getToolDefinition(config) {
  return {
    /* ... */
  };
}

// 4. Tool handler
export async function handleToolCall(request, instance) {
  // ...
}
```

### Error Handling

```javascript
// Always handle errors gracefully
try {
  // operation
} catch (error) {
  console.error('[Module] Error description:', error.message);
  // Continue execution or return default value
}
```

### Logging

- Use `console.info()` for normal server lifecycle output (redirected to logs in MCP mode)
- Use `console.warn()` for non-fatal issues and `console.error()` for errors
- CLI utilities and install scripts may use `console.info()` for user-friendly output

## Adding New Features

### Step-by-Step Guide

1. **Create Feature File**

Create `features/your-feature.js`:

```javascript
export class YourFeature {
  constructor(embedder, cache, config) {
    this.embedder = embedder;
    this.cache = cache;
    this.config = config;
  }

  async execute(params) {
    // Implementation
    return { result: 'data' };
  }
}

export function getToolDefinition(config) {
  return {
    name: 'your_tool',
    description: 'Clear description of what the tool does',
    inputSchema: {
      type: 'object',
      properties: {
        param: {
          type: 'string',
          description: 'Parameter description',
        },
      },
      required: ['param'],
    },
  };
}

export async function handleToolCall(request, instance) {
  const params = request.params.arguments;
  const result = await instance.execute(params);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
```

2. **Register Feature**

Update `index.js`:

```javascript
import * as YourFeature from './features/your-feature.js';

// In initialize():
const yourFeature = new YourFeature.YourFeature(embedder, cache, config);

// Add to features array:
features.push({
  module: YourFeature,
  instance: yourFeature,
  handler: YourFeature.handleToolCall,
});
```

3. **Test Your Feature**

- Test with a sample codebase
- Verify MCP tool contract
- Check error handling and output format

4. **Document Your Feature**

- Add to README.md features section
- Update ARCHITECTURE.md if needed

## Testing

```bash
npm test
```

By default, tests use a mock embedder to avoid network/model downloads. To run the real model tests:

```bash
USE_REAL_EMBEDDER=true npm test
```

## Pull Request Process

1. **Fork the repository**

2. **Create a feature branch**

```bash
git checkout -b feature/your-feature-name
```

3. **Make your changes**

- Follow code style guidelines
- Add appropriate comments
- Test thoroughly

4. **Commit your changes**

```bash
git add .
git commit -m "Add feature: description"
```

Follow commit message conventions:

- `Add feature: description` - New features
- `Fix: description` - Bug fixes
- `Update: description` - Updates to existing code
- `Docs: description` - Documentation changes

5. **Push to your fork**

```bash
git push origin feature/your-feature-name
```
