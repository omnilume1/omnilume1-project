# Omnilume Final Product Draft

This draft includes your original features, your modifications, and only the most important recommended additions:

- Room activity hub
- Scheduling and reminders
- Reactions and polls
- Room history and memories
- Reconnect and synchronization recovery
- AI study tools
- AI watch assistance
- Strong moderation and privacy controls
- Media metadata enrichment

The application should be built phase by phase. The complete product is too large to build safely in one step.

---

# 1. Omnilume Product Definition

Omnilume is a social platform based around shared digital spaces.

A user can:

```text
Create an account
    → Add friends
    → Create or join a room
    → Chat and share files
    → Watch movies or series
    → Listen to music
    → Study together
    → Join voice/video calls
    → Save notes and progress
```

Omnilume has two main social spaces:

| Space | Purpose |
|---|---|
| **Room** | Temporary or permanent shared session |
| **Group** | Permanent community with members, files, chat, and history |

A room can contain multiple activities:

- Watch
- Music
- Study
- Chat
- Calls
- Files
- Notes
- Whiteboard
- Polls
- Games
- AI tools

One activity is highlighted as the **main activity**, while smaller tools remain available in the room interface.

---

# 2. Account Creation and Profile

## Google account creation

Users create their account with Google.

```text
Continue with Google
        ↓
Google verifies identity
        ↓
Omnilume creates account
        ↓
User completes profile
        ↓
User enters home page
```

## Required profile setup

The user provides:

- Username
- Display name
- Date of birth
- Gender
- Adult status derived from date of birth
- Profile picture
- Account visibility
- Optional biography

The following should be private by default:

- Date of birth
- Exact age
- Gender
- Private activity
- Study history
- Personal files

The adult status should be calculated from the date of birth. Users should not be able to falsely claim that they are adults by simply selecting an option.

## Username rules

Usernames should work like Instagram handles.

Rules:

- Always stored in lowercase
- Always displayed in lowercase
- Unique regardless of uppercase or lowercase input
- Allowed characters: lowercase letters, numbers, periods, and underscores
- No spaces
- Fixed length limit
- Cannot use another user’s reserved or protected name
- Can be changed once every 30 days

Example:

```text
Rohan_123
rohan_123
ROHAN_123
```

All three represent the same username: `rohan_123`.

If `rohan_123` is taken, another person cannot claim it by using uppercase letters.

When a user changes their username:

- The old username is temporarily reserved
- The profile URL is updated
- Existing friends remain connected
- Old links should redirect for a limited period
- Users cannot repeatedly change usernames to impersonate others

## Password login later

After Google registration, the user can add a password from settings.

Users can then log in using:

- Google
- Username and password

The system should require Google verification before setting a password. Passwords must be securely hashed and never stored as readable text.

Users should also have:

- Password reset
- Active-session management
- Logout from all devices
- Optional two-factor authentication
- Account recovery through Google or verified email

---

# 3. Public and Private Profiles

## Public accounts

Other users can:

- Search the username
- View the public profile
- Follow the account
- Send a friend request
- Send a message request if allowed
- View selected public activity

## Private accounts

Other users can:

- Find the username
- Send a follow request
- Send a friend request
- See limited profile information
- View content only after approval

Users can separately control:

- Who can follow them
- Who can send friend requests
- Who can send messages
- Who can call them
- Who can invite them to rooms
- Whether activity status is visible

---

# 4. Home Page

The home page should be calm and focused.

It should not display every Omnilume feature at once.

## Main home content

- Greeting
- Upcoming schedules
- Recent rooms
- Active rooms
- Friends currently online
- Pending invitations
- Continue watching
- Continue listening
- Current study progress
- Important notifications

## Visual design

Use:

- Black background
- Dark grey surfaces
- White text
- Muted grey secondary text
- Small accent colors
- Subtle glass effects
- Minimal animations
- Responsive mobile layout

## Profile menu

The user’s circular profile picture appears in the upper-right corner.

When clicked:

- A side panel slides into view
- The main page becomes slightly blurred
- The side panel receives focus
- The user can close the panel by clicking outside or pressing Escape

The panel includes:

- Open profile
- History
- Notifications
- Settings
- Switch account
- Add account
- Logout

## Account switching

Users can:

- Switch accounts
- Add another account
- Remove a saved account
- Log out of one account
- Log out of all accounts

---

# 5. Friends, Following, and Messaging

Following and friendship are different.

## Following

Following is one-directional and useful for public profiles and creators.

## Friendship

Friendship is mutual and allows:

- Private chat
- Voice calls
- Video calls
- File sharing
- Room invitations
- Study invitations
- Watch invitations
- Music invitations

## Personal messaging privacy

Personal messages should be:

- End-to-end encrypted by default
- Available only to the participants
- Encrypted before being sent to the server
- Stored as encrypted data
- Unreadable by the site owner

The server may still see limited metadata such as:

- Message timing
- Account identifiers
- File size
- Delivery status
- Device information

The server must not have access to message content or encryption keys.

---

# 6. Rooms

## Creating a room

The room creator selects:

- Room name
- Room image
- Public or private visibility
- Room username, optional
- Member limit
- Expiration type
- Expiration time
- Whether conversion to a group is allowed
- Whether recovery is allowed
- Main activity
- Playback control settings
- File-sharing permissions
- Call permissions
- E2EE option

Omnilume creates:

- Random room code
- Invite link
- Optional QR code

## Joining rooms

Users can join through:

- Room code
- Invite link
- QR code
- Public room search
- Unique room username
- Join request
- Friend invitation

## Private rooms

Private rooms can require:

- Owner approval
- Admin approval
- An invitation
- A valid private link
- A valid room code

Private rooms should not appear in public search.

## Public rooms

Public rooms can:

- Appear in search
- Show their description
- Show member count
- Show public chat before joining
- Allow anyone to request or immediately join
- Have moderators
- Use slow mode
- Restrict file uploads
- Restrict voice and video access

Users who have not joined a public room should normally be able to read but not participate.

Public rooms cannot use true end-to-end encryption because the conversation is intentionally visible to non-members.

---

# 7. Room Roles and Permissions

Roles should include:

- Owner
- Admin
- Moderator
- Member
- Guest

The owner can:

- Change room settings
- Assign admins
- Assign moderators
- Remove members
- Ban members
- Lock the room
- Hide the room
- Control files
- Control media
- Change expiration
- Convert the room into a group
- Transfer ownership
- Delete the room

Permissions should be separate for:

- Text chat
- File uploads
- Media control
- Queue editing
- Notes
- Whiteboard
- Polls
- Voice
- Video
- Screen sharing
- AI features

A user may be allowed to edit a playlist but not control video playback.

---

# 8. Multiple Activities

A room can contain multiple activities at the same time.

## Main activity

The main activity receives the largest area of the interface.

Examples:

- Watch player
- Music player
- Study workspace
- Whiteboard
- Public event

## Secondary tools

Smaller tools appear in a dock or side panel:

- Chat
- Members
- Music
- Notes
- Whiteboard
- Timer
- Polls
- AI assistant
- Call controls

Recommended rule:

- Only one primary shared media clock operates at a time
- Music can continue as background music during Study
- Chat and calls can remain available in every activity
- Each activity remembers its own state

---

# 9. Room Expiration and Deletion

There should be three room lifecycle types.

## Permanent room

- Does not expire automatically
- Exists until the owner schedules deletion
- Has a 7–14 day deletion grace period
- Owner can cancel deletion during that period

## Recoverable temporary room

When its timer ends:

- It immediately disappears for members
- Users cannot join it
- Chat and files become inaccessible
- Members can request recovery
- The room enters administrative quarantine
- The site owner can review and restore eligible data

This is not true permanent deletion because the server retains the data temporarily.

## Irreversible temporary room

When its timer ends:

- It disappears immediately
- It cannot become permanent
- It cannot become a group
- Members cannot request recovery
- The creator cannot request recovery
- The site owner cannot restore it
- Storage keys and data are permanently destroyed

The room information panel should clearly display the selected deletion policy before users join.

## E2EE room expiration

For E2EE rooms:

- The platform owner cannot decrypt the content
- Recovery is possible only if authorized members still possess the encryption keys
- If the encryption key is permanently destroyed, the data cannot be recovered

---

# 10. Group Conversion

A room can be converted into a permanent group only if the owner enabled conversion.

During conversion, the owner chooses whether to preserve:

- Members
- Admins
- Chat history
- Documents
- Images
- Videos
- Music
- Notes
- Whiteboards
- Playlists
- Room history
- Poll results

The group then receives:

- Permanent group identity
- Group username
- Permanent chat
- Permanent file library
- Group admins
- Group notes
- Group playlists
- Ability to create future temporary rooms

If the room was marked irreversible, conversion is impossible.

---

# 11. Chat

Chat should work inside:

- Private messages
- Rooms
- Groups
- Public rooms
- Study rooms
- Watch sessions
- Music sessions

## Chat features

- Text
- Replies
- Mentions
- Reactions
- GIFs
- Images
- Documents
- Audio files
- Videos
- Pinned messages
- Message search
- Message editing
- Message deletion
- Typing indicators
- Read status
- Unread counts

## GIFs

Users can:

- Search GIFs
- Send GIFs
- Save GIFs from other users
- Create a saved GIF collection

Use Giphy or Tenor with proper API permissions. Avoid copying third-party GIF files unnecessarily.

---

# 12. File Sharing

Users can share:

- Images
- Videos
- PDFs
- Documents
- Presentations
- Spreadsheets
- Music
- ZIP files
- GIFs

The upload system should provide:

- Upload progress
- Chunked uploads
- Pause
- Resume
- Cancel
- Retry
- File previews
- Download
- Rename
- Delete
- Pin
- Access permissions
- File size display

Large files should be stored in object storage, not inside the database.

## Permanent files

Permanent files belong to:

- A user
- A group
- A permanent room

They should not belong only to an expiring room.

---

# 13. Temporary Direct File Links

A user can create a temporary link similar to ToffeeShare.

## Sender flow

```text
Sender selects file
        ↓
Creates temporary link
        ↓
Keeps browser open and remains online
        ↓
Receiver opens link
        ↓
File transfers directly
```

The sender can set:

- Expiration time
- Download limit
- Password
- One-time download
- Login requirement
- Receiver approval

The sender can:

- Pause transfer
- Cancel link
- See progress
- Disconnect receiver
- See whether the receiver is connected

The transfer should use:

- WebRTC
- Chunking
- Resume support
- File checksums
- End-to-end encryption
- Encrypted relay fallback when direct transfer fails

If the sender disconnects and no relay is active, the transfer stops.

---

# 14. Media Metadata System

When users upload movies, series, anime, or music, Omnilume should process the file in the background.

## Media processing flow

```text
File uploaded
        ↓
File type and metadata detected
        ↓
Embedded tags are read
        ↓
Filename is analyzed
        ↓
External metadata providers are searched
        ↓
Possible matches are shown
        ↓
User confirms or edits match
        ↓
Metadata is saved
```

## Movie and series metadata

Possible providers:

- TMDB API
- OMDb API
- IMDb licensed data or API access, if available
- AniList GraphQL API for anime
- TVMaze or similar television metadata providers

IMDb should not be assumed to provide a freely available API for every use case. Use only an official or properly licensed source.

Metadata can include:

- Title
- Original title
- Release date
- Description
- Genres
- Posters
- Backdrops
- Cast
- Directors
- Writers
- Seasons
- Episodes
- Runtime
- Languages
- Country
- Ratings
- Age classification
- External IDs

## Music metadata

Possible providers:

- MusicBrainz
- Cover Art Archive
- Tidal API, where access and permissions allow
- Spotify API for metadata, where permitted
- Apple Music API, where permitted
- Other licensed music metadata providers

Embedded audio tags should be read first.

The system should attempt to identify:

- Song title
- Artist
- Album
- Album artist
- Composer
- Writers
- Producers
- Genre
- Release year
- Track number
- ISRC
- Album artwork
- Duration
- Lyrics availability

The best way to match music is by using identifiers such as ISRC, UPC, title, and artist rather than relying only on filenames.

## Lyrics

Lyrics can come from:

- Embedded lyrics in the file
- A licensed lyrics provider
- A provider that explicitly permits lyrics display

Do not scrape lyrics from websites.

Lyrics may be:

- Unsynchronized
- Time-synchronized
- Missing
- Unlicensed

The player should clearly show when lyrics are unavailable.

## Metadata fallback

If no external provider finds a match:

- Use embedded file metadata
- Allow the user to edit details manually
- Allow the user to upload artwork
- Save the corrected metadata

External metadata should be cached to reduce API requests, while following provider attribution and licensing rules.

---

# 15. Watch Activity

Users can watch:

- Movies
- Series
- Anime
- Uploaded lecture videos
- YouTube study videos
- Other legally embeddable content

## Watch features

- Browse media library
- Search content
- Select movie
- Select series
- Select season
- Select episode
- Play
- Pause
- Seek
- Fullscreen
- Change volume
- Playback speed
- Continue watching
- Watch history
- Episode progress
- Next episode
- Chat beside the player

## Shared playback state

The room shares:

- Current media
- Current episode
- Play or pause state
- Playback position
- Current controller
- Queue
- Main activity state

Each user controls personally:

- Volume
- Audio language
- Subtitle language
- Subtitle appearance
- Personal playback preference

## Playback permissions

The owner can choose:

- Owner only controls
- Owner and admins control
- Everyone controls
- Members vote before changing playback

The recommended default is owner-controlled playback.

## Watch modes

### Host casting

One person shares:

- Browser tab
- Application window
- Entire screen
- Audio

This is useful for external content but may have:

- Lower quality
- More delay
- More bandwidth usage
- Device compatibility issues

### Temporary server upload

A user uploads a movie, series, or song for 24 hours.

After upload completion:

- The server stores the temporary file
- The file is processed
- Metadata is enriched
- Compatible playback versions are created
- Members can watch together
- Members can watch alone during the 24-hour period
- The file is automatically removed afterward

### Permanent server media

Permanent authorized media remains in a user or group library.

---

# 16. Language and Subtitle Preferences

Users can independently choose:

- Audio language
- Subtitle language
- Subtitle visibility
- Subtitle size
- Subtitle color
- Subtitle background
- Subtitle position

Example:

```text
User A: Hindi audio + English subtitles
User B: English audio + Hindi subtitles
User C: English audio + no subtitles
```

All users continue watching the same playback position.

Multiple audio languages require multiple audio tracks. Multiple subtitle languages require multiple subtitle tracks.

---

# 17. Music Activity

## Personal music

Users can:

- Upload music
- Browse music
- Search music
- Play songs
- Create playlists
- Download authorized files
- Continue listening
- View history
- See album and artist details
- View lyrics where legally available

## Shared music

Room members can:

- Start shared listening
- Add songs
- Remove songs
- Reorder songs
- Vote to skip
- Save the queue
- Synchronize play and pause
- Synchronize seeking
- See who added each song

The owner can control:

- Who changes the current song
- Who changes volume
- Who edits the queue
- Whether members can skip

## Study music

The Study interface can include a compact music player with:

- Personal playlist
- Shared room playlist
- Play and pause
- Progress
- Volume
- Queue
- Current track details

---

# 18. Study Activity

Study rooms support:

- Personal study
- Group study
- Focus sessions
- PDFs
- Notes
- Lecture videos
- YouTube videos
- Whiteboards
- Tasks
- Study playlists
- AI study tools

## Focus mode

The user selects:

- Subject
- Duration
- Personal or shared timer
- Break schedule
- Playlist
- Study material

During focus mode:

- Timer remains visible
- Entertainment navigation is hidden
- Approved study tools remain available
- User can pause and resume
- Actual study time is recorded
- User can end early with confirmation

The website cannot stop users from opening another browser tab or application.

## Study history

The system records:

- Subject
- Planned duration
- Actual focused time
- Pause time
- Start time
- End time
- Completion status
- Room
- User

Users can view:

- Hours per subject
- Daily and weekly totals
- Monthly statistics
- Study streaks
- Longest session
- Completed goals
- Weak subjects

## Notes

Notes can be:

- Private
- Shared with a room
- Shared with a group
- Read-only
- Collaborative

Features include:

- Rich text
- Headings
- Lists
- Checklists
- Links
- Images
- Code blocks
- Search
- Folders
- Sharing
- Version history
- Export

## PDFs

Users can:

- Upload PDFs
- Read them inside Omnilume
- Search text
- Zoom
- Bookmark pages
- Highlight
- Add notes
- Share documents
- Continue from the last page

## Whiteboard

The whiteboard supports:

- Drawing
- Writing
- Erasing
- Shapes
- Lines
- Arrows
- Text
- Highlights
- Colors
- Undo
- Redo
- Zoom
- Multiple boards
- Shared and private boards
- Export

## YouTube and lecture videos

Users can:

- Paste a YouTube URL
- Open an uploaded lecture
- Save it to study resources
- Watch together
- Continue watching
- Add notes and timestamps

---

# 19. AI Features

Only add AI features that solve real user problems.

## Lume Study

Lume can:

- Explain uploaded material
- Generate notes
- Create flashcards
- Create quizzes
- Create practice exams
- Summarize chapters
- Find weak topics
- Build revision plans
- Answer with page citations
- Link answers to video timestamps

Use Gemini 3.6 Flash for large multimodal files and GPT-5.6 Luna for explanations and structured study tools.

## Lume Watch

Lume can:

- Create spoiler-safe recaps
- Explain current scenes
- Answer character questions
- Translate dialogue
- Create discussion questions
- Generate watch-party trivia
- Find important timestamps

The user should choose the spoiler level before asking questions.

## Lume Music

Lume can:

- Generate playlists from natural-language prompts
- Combine multiple members’ preferences
- Suggest similar tracks
- Create study playlists
- Explain why a song was selected

It must choose real tracks from an authorized catalog.

## AI room recap

After a session, Lume can summarize:

- Media watched
- Songs played
- Important discussion points
- Study goals
- Quiz results
- Saved moments

Users must approve the recap before it becomes permanent.

## AI privacy rules

AI must not automatically access:

- E2EE messages
- E2EE calls
- Private files
- Private notes
- Personal study history

Users must explicitly choose what the AI can read.

---

# 20. Voice, Video, and Screen Sharing

Users can have:

- Private voice calls
- Private video calls
- Room voice chat
- Group video calls
- Camera controls
- Microphone controls
- Screen sharing
- Participant list
- Speaking indicators
- Mute controls

Use a managed WebRTC service such as LiveKit, Daily, Agora, or Twilio.

## Encryption

- Personal calls must use audited E2EE technology
- Normal rooms use encrypted transport and member access controls
- Private E2EE groups can use client-side encryption
- The platform owner can delete, hide, lock, or ban users without seeing encrypted content

Do not create custom encryption algorithms.

---

# 21. Realtime Synchronization

Realtime is required for:

- Chat
- Member presence
- Playback
- Music queues
- Focus timers
- Polls
- Whiteboard updates
- Notes
- Call signaling
- Typing indicators

The server should be the authority for shared state.

Every important realtime event should include:

- Event ID
- Sender
- Timestamp
- Room ID
- Event type
- State version
- Permission result

When a user reconnects:

```text
Reconnect
    → Fetch latest room state
    → Compare local state
    → Apply missing events
    → Correct playback or timer
```

Presence and cursor positions should be temporary. Messages, notes, and study records should be permanent.

---

# 22. Interactive Features

Important additions that fit Omnilume:

## Room Pulse

- Polls
- Reactions
- Mood meter
- Predictions
- Questions
- Voting

## Room Memories

- Saved movie moments
- Important messages
- Shared images
- Study milestones
- Favorite songs
- Whiteboard snapshots

## Scheduling

- Movie nights
- Study sessions
- Focus sessions
- Music sessions
- Group events
- Reminders
- Calendar links
- RSVP

## Room activity history

Users can see:

- Previous activities
- Watched media
- Played music
- Completed study sessions
- Saved notes
- Important room events

These features encourage users to return without turning Omnilume into an endless social-media feed.

---

# 23. Moderation and Platform Administration

The platform owner can manage:

- Accounts
- Public rooms
- Groups
- Reports
- Files
- Metadata
- Storage
- Bans
- Hidden content
- Locked rooms
- Expired recoverable rooms

For E2EE content, the platform owner can manage:

- Message IDs
- Access permissions
- Room membership
- Deletion
- Hiding
- Locking
- Banning

The owner cannot view the plaintext content or listen to the encrypted call.

Public rooms need:

- Report tools
- Spam controls
- Slow mode
- Moderator roles
- File restrictions
- User blocking
- Human review
- AI moderation assistance

---

# 24. Recommended Architecture

```text
Web and mobile clients
        ↓
Authentication service
        ↓
Application API
        ↓
Room and group service
        ↓
Permission service
        ↓
Database
        ↓
Realtime event service
```

Separate media systems:

```text
Media upload
        ↓
Object storage
        ↓
Background processing
        ↓
Metadata providers
        ↓
Transcoding
        ↓
CDN
        ↓
Video or music player
```

Separate communication systems:

```text
Text messages → Message service
Voice/video → WebRTC and SFU
E2EE messages → Client-side encryption
Whiteboard → Collaboration sync service
Temporary files → WebRTC peer-to-peer transfer
```

Recommended tools:

- Next.js
- Supabase Auth
- Supabase PostgreSQL
- Supabase Realtime
- Cloudflare R2
- FFmpeg
- HLS or DASH
- LiveKit
- tldraw
- Liveblocks or Yjs
- TMDB
- AniList
- MusicBrainz
- Licensed lyrics provider
- Giphy or Tenor
- Sentry
- PostHog
- Vercel

---

# 25. Final Implementation Order

The AI building Omnilume should follow this exact order:

1. Project foundation
2. Google authentication
3. Profile setup
4. Lowercase username system
5. Public/private account settings
6. Simple home page
7. Profile side panel
8. Account switching
9. Friends and following
10. Private messaging
11. Room creation
12. Room codes and invite links
13. Public and private rooms
14. Room roles and permissions
15. Room expiration policies
16. Group conversion
17. Basic room chat
18. GIFs and reactions
19. File uploads
20. Permanent file library
21. Realtime presence
22. Reconnect handling
23. Video player
24. Synchronized playback
25. Personal audio and subtitle settings
26. Movie and series metadata
27. Music player
28. Shared queue and playlists
29. Music metadata and lyrics
30. Temporary 24-hour media uploads
31. Study rooms
32. Focus timer and study history
33. Notes
34. PDF reader
35. Lecture and YouTube videos
36. Whiteboard
37. Voice calls
38. Video calls
39. Screen sharing
40. Casting support
41. AI Study Lens
42. AI Watch Companion
43. AI playlist generation
44. AI room recaps
45. Scheduling and reminders
46. Public-room moderation
47. E2EE private groups
48. Temporary peer-to-peer file links
49. Mobile application
50. Production security, backups, monitoring, and scaling

# Instructions for the Building AI

Give the AI this rule:

> Build Omnilume phase by phase. Never implement the entire product in one request. Before changing anything, explain the files, database changes, security implications, and dependencies. Implement only the current phase. Test every feature before starting the next phase. Preserve all decisions in the project documentation. Never invent media metadata, bypass DRM, create custom encryption, expose private content, or put large files inside the database.

This draft is suitable as the main product specification for you and your friend to review before giving the final development order.