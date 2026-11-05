# OmniLume

<p align="center">
  <strong>One space to watch, study, and connect together.</strong>
</p>

<p align="center">
  OmniLume is a real-time collaborative web platform built around shared rooms — bringing synchronized media, group study, messaging, presence, and social interaction into one connected experience.
</p>

<p align="center">
  <a href="https://omnilume.vercel.app">Live Demo</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#architecture">Architecture</a>
  ·
  <a href="#getting-started">Getting Started</a>
</p>

---

## ✨ What is OmniLume?

Most online collaboration tools make you jump between different apps:

**Discord for chat.**  
**Watch-party tools for media.**  
**Separate timers for studying.**  
**Another app for files and shared sessions.**

OmniLume brings those experiences together around a single idea:

> **A room is your shared digital space.**

Create a room, invite people, and use the same space to watch something together, study together, chat privately, share media, and stay synchronized.

The goal is simple:

**Less switching. More doing things together.**

---

## 🚀 Features

### 🎬 Watch Together

Turn a room into a synchronized viewing space.

- Shared media playback
- Room-level playback state
- Watch-party style synchronization
- Shared media workflows
- Room-based collaboration around media

### 📚 Study Together

A shared environment for focused sessions.

- Study sessions
- Shared focus-oriented workflows
- Group accountability
- Room-based study activity

### 💬 Chat Together

Keep conversations inside the same room.

- Real-time room messaging
- Message ownership controls
- Delete for Everyone behavior
- Private messaging
- Browser-side encrypted private-chat data handling
- Notifications for relevant activity

### 👥 Shared Rooms

Rooms are the core of OmniLume.

- Public and private rooms
- Room membership and roles
- Approved-member access
- Room discovery and exploration
- Room links and join flows
- Temporary room lifecycle
- Recovery and permanent-room conversion workflows

### 🔔 Notifications

Stay informed without constantly checking every room.

- Personal notifications
- Room-related events
- Recovery/permanence notifications
- Privacy-aware notification access

### 🔐 Security First

OmniLume treats authorization as a core part of the product rather than an afterthought.

- Supabase Row Level Security (RLS)
- Server-side authentication and authorization
- Membership/capability checks
- Protected room and message access
- Browser-side WebCrypto-based private messaging
- Protected storage access
- Recovery and permanent-room authorization rules

> Security-sensitive functionality is designed around server-side authorization and database policies, not UI visibility alone.

---

## 🧠 Product Model

OmniLume is organized around a simple hierarchy:

```text
                    OMNILUME
                       │
                    HOME
                       │
        ┌──────────────┼──────────────┐
        │              │              │
     My Rooms       Explore        Create/Join
        │              │              │
        └──────────────┼──────────────┘
                       │
                    ROOM
                       │
      ┌────────────────┼────────────────┐
      │                │                │
    Watch             Study             Chat
      │                │                │
      └────────────────┼────────────────┘
                       │
              Shared Room State
```

The **Home** experience acts as the user's control center.

The **Room** is where collaboration actually happens.

That separation keeps OmniLume feeling like one product instead of a collection of disconnected features.

---

## 🏗️ Architecture

OmniLume uses a modern full-stack architecture:

```text
Browser
   │
   ├── Next.js App Router
   │       │
   │       ├── React UI
   │       ├── Server Components
   │       ├── Client Components
   │       └── Server Actions
   │
   ├── Supabase
   │       ├── PostgreSQL
   │       ├── Authentication
   │       ├── Row Level Security
   │       ├── Storage
   │       └── Realtime
   │
   └── WebCrypto
           └── Browser-side encryption
```

### Core stack

| Layer | Technology |
|---|---|
| Framework | Next.js |
| UI | React |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Backend | Next.js Server Actions / Route Handlers |
| Database | PostgreSQL via Supabase |
| Authentication | Supabase Auth |
| Authorization | Supabase RLS + capability checks |
| Realtime | Supabase Realtime |
| Storage | Supabase Storage |
| Encryption | Browser WebCrypto |
| Deployment | Vercel |

---

## 📁 Project Structure

A simplified view of the application:

```text
src/
├── app/                # Routes and pages
├── actions/            # Server-side application actions
├── components/         # UI and feature components
├── hooks/              # Client-side state/realtime hooks
├── lib/                # Shared business logic and utilities
├── utils/
│   └── supabase/       # Supabase clients and helpers
└── proxy.ts            # Auth/session routing and protection

supabase/
├── 01_schema.sql       # Canonical schema snapshot
├── POLICIES.md         # Security/policy documentation
└── migrations/         # Database migrations

vercel.json             # Deployment/cron configuration
```

---

## 🔄 How a Room Works

The basic experience is designed around a single shared room state.

```text
User
 │
 ├── Authenticate
 │
 └── Enter Room
        │
        ├── Membership / capability checks
        │
        ├── Shared media state
        ├── Chat
        ├── Presence
        ├── Study state
        └── Notifications
```

Persistent data is protected through Supabase authorization policies, while live collaboration uses realtime channels and client-side state synchronization.

---

## 🔐 Security Philosophy

OmniLume follows a defense-in-depth approach:

```text
Authentication
      ↓
Authorization
      ↓
Membership / Capability Checks
      ↓
Database RLS
      ↓
Protected Storage
      ↓
Controlled Realtime State
```

The application is designed so that hiding a button in the UI is **not** treated as a security boundary.

Sensitive operations should still be protected when called directly.

---

## 🧪 Quality & Verification

The project is continuously verified through static and runtime checks including:

- TypeScript validation
- ESLint
- Production build validation
- Git diff checks
- Supabase migration alignment
- RLS/security regression testing
- Multi-user browser verification
- Production smoke checks

The repository is actively evolving, so some advanced realtime and lifecycle scenarios may require additional end-to-end coverage as the platform grows.

---

## 🛣️ Roadmap

OmniLume is being developed toward a more complete collaborative operating space.

### Near term

- Stronger Realtime authorization
- Scalable chat/history pagination
- Server-side payload and upload limits
- More robust cleanup and lifecycle handling
- Automated security and RLS tests
- Performance improvements for large rooms

### Beyond

- A richer personalized Home dashboard
- Better discovery and room recommendations
- More collaborative study tools
- Expanded media integrations
- Deeper room customization
- More powerful notification and activity systems

---

## 💻 Getting Started

### Prerequisites

- Node.js
- npm
- A Supabase project
- Required environment variables

### Install

```bash
git clone <your-repository-url>
cd OmniLume
npm install
```

### Environment

Create a `.env.local` file containing the Supabase and application configuration required by the project.

Do not commit secrets, service-role keys, database passwords, or deployment tokens.

### Run locally

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

### Useful commands

```bash
npm run lint
npx tsc --noEmit
npm run build
```

---

## 🌐 Live

**Production:** https://omnilume.vercel.app

---

## 🤝 Contributing

Contributions, ideas, bug reports, and architectural discussion are welcome.

Before changing security-sensitive areas such as:

- RLS
- authentication
- Realtime authorization
- room membership
- storage policies
- encryption

please understand the existing security model and test the affected flows.

---

## 📜 License

See the repository for licensing information.

---

<p align="center">
  <strong>OmniLume</strong><br/>
  Watch together. Study together. Talk together.
</p>
