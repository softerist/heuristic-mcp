# Contributing to Smart Coding MCP

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm or yarn
- Git

### Setup Development Environment

```bash
# Fork and clone the repository
git clone https://github.com/omar-haris/smart-coding-mcp.git
cd smart-coding-mcp

# Install dependencies
npm install

# Run in development mode
npm run dev
```

## Project Structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed information about the modular architecture.

Key directories:

- `lib/` - Core libraries and utilities
- `features/` - Pluggable feature modules
- `scripts/` - Utility scripts

## Development Guidelines

### Code Style

- Use ES6+ JavaScript features
- Follow existing code patterns
- Use meaningful variable and function names
- Add comments for complex logic
- No emojis in code or documentation

### File Organization

```javascript
// Standard file structure for features:

// 1. Imports
import { dependency } from "package";

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
  console.error("[Module] Error description:", error.message);
  // Continue execution or return default value
}
```

### Logging

Use `console.error()` for all logs (MCP protocol requirement):

```javascript
console.error("[FeatureName] Informational message");
console.error("[FeatureName] Warning:", details);
console.error("[FeatureName] Error:", error.message);
```

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
    return { result: "data" };
  }
}

export function getToolDefinition(config) {
  return {
    name: "your_tool",
    description: "Clear description of what the tool does",
    inputSchema: {
      type: "object",
      properties: {
        param: {
          type: "string",
          description: "Parameter description",
        },
      },
      required: ["param"],
    },
  };
}

export async function handleToolCall(request, instance) {
  const params = request.params.arguments;
  const result = await instance.execute(params);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
```

2. **Register Feature**

Update `index.js`:

```javascript
import * as YourFeature from "./features/your-feature.js";

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

- Test with sample codebase
- Verify MCP tool contract
- Check error handling
- Validate output format

4. **Document Your Feature**

- Add to README.md features section
- Create examples in EXAMPLES.md
- Update ARCHITECTURE.md if needed

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

6. **Create Pull Request**

- Provide clear description of changes
- Reference any related issues
- Include examples of usage
- Explain testing performed

## Testing

### Manual Testing

```bash
# Test with a sample project
cd /path/to/test/project
node /path/to/smart-coding-mcp/index.js

# In another terminal, send MCP requests
```

### Testing MCP Tools

Create a test script:

```javascript
// test-tool.js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
// ... setup and test your tool
```

## Configuration Changes

If adding new configuration options:

1. Update `lib/config.js` with new default values
2. Document in README.md
3. Add examples to EXAMPLES.md
4. Consider backward compatibility

## Documentation

All documentation should:

- Be clear and concise
- Include code examples
- Avoid emojis
- Use proper markdown formatting
- Be kept up-to-date with code changes

## Code Review Checklist

Before submitting a PR, verify:

- [ ] Code follows project style guidelines
- [ ] No console.log (use console.error for MCP)
- [ ] Error handling is implemented
- [ ] Configuration changes are documented
- [ ] README.md is updated if needed
- [ ] No breaking changes without discussion
- [ ] Comments explain complex logic
- [ ] No emojis in code or documentation

## Feature Ideas

Looking for ideas? Consider implementing:

- Code complexity analysis
- Pattern detection and anti-pattern identification
- Documentation generation
- Refactoring suggestions
- Test coverage analysis
- Dependency graph visualization
- Performance profiling integration
- Multi-language translation support

## Questions and Support

- **Issues**: Use GitHub Issues for bugs and feature requests
- **Discussions**: Use GitHub Discussions for questions
- **Email**: Contact Omar Haris via LinkedIn

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Smart Coding MCP!
