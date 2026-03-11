---
description: Development workflow for AtoA Stream - run dev servers, build, install packages
---

// turbo-all

## Development

1. Install all dependencies:
```bash
npm install
```

2. Run the Next.js dev server:
```bash
npm run dev
```

3. Run the relay server:
```bash
node server/index.js
```

4. Build the project:
```bash
npm run build
```

5. Run dummy agent test:
```bash
node server/dummy-agent.js
```
