# 2D Multiplayer Metaverse — Frontend Agent Specification & Protocol Contracts

> **Handover Document for Frontend AI Agents (React + Phaser + WebRTC Client)**

---

## 1. Application Overview & Context

This project is a **2D Multiplayer Metaverse (Gather.town clone)** built with **NestJS, PostgreSQL, Prisma, Socket.IO, and WebRTC**.

### What the Application Does:
1. **Durable Identity & Rooms**: Users register and log in to receive a JWT. Users can create virtual rooms (e.g., offices, conference spaces) and share 6-character invite codes (e.g. `A3F9B1`) with friends.
2. **Real-Time 2D World (Phaser/Canvas)**: Once inside a room, users connect via Socket.IO. Each player controls a 2D avatar that moves around a bounded map (default: $1000 \times 1000$ pixels) using arrow keys or WASD.
3. **Server-Authoritative Movement**: The backend validates player movements against room boundaries and physics speed limits to prevent hacking, broadcasting validated movements to all peers in the room.
4. **In-Room Chat**: Players can type messages in real time. Messages are both saved to PostgreSQL and broadcast live to everyone in the room.
5. **The Proximity Engine**: The backend continuously monitors avatar distances in 2D space.
   - When Player A and Player B walk within **150 pixels** of each other, the server emits `proximity:enter` to both players.
   - When they walk more than **150 pixels** apart, the server emits `proximity:leave` to both players.
6. **Peer-to-Peer Proximity Audio/Video & Screen Sharing (WebRTC)**:
   - `proximity:enter` triggers the browser to initiate a direct peer-to-peer WebRTC audio/video call.
   - The backend acts as the **Signaling Matchmaker**, routing SDP Offers, Answers, and ICE Candidates.
   - Media flows **directly browser-to-browser** (does NOT touch the backend).
   - `proximity:leave` automatically tears down the media call.
   - Users can toggle screen sharing, which broadcasts to peers currently in audio/video range.

---

## 2. Server Configuration

- **REST API Base URL**: `http://localhost:3000`
- **Socket.IO Gateway URL**: `http://localhost:3000`
- **CORS**: Enabled for all frontend origins (`*`).
- **Auth Header format**: `Authorization: Bearer <accessToken>`
- **Rate Limiting**:
  - Global: 100 requests / minute
  - Sensitive endpoints (`/auth/register`, `/auth/login`): 5 requests / minute
  - Room join (`/rooms/join`): 10 requests / minute
  - Exceeding returns `429 Too Many Requests`

---

## 3. REST API Specification

### Authentication

#### 1. Register User
- **Endpoint**: `POST /auth/register`
- **Body**:
  ```json
  {
    "email": "alice@metaverse.com",
    "password": "password123",
    "displayName": "Alice",
    "avatar": "avatar-1"
  }
  ```
- **Response (`201 Created`)**:
  ```json
  {
    "accessToken": "eyJhbGciOiJIUzI1NiIsIn...",
    "user": {
      "id": "e5b6c2d1-4f3a-4b1a-8e2c-3d4f5a6b7c8d",
      "email": "alice@metaverse.com",
      "displayName": "Alice",
      "avatar": "avatar-1",
      "createdAt": "2026-10-25T..."
    }
  }
  ```

#### 2. Login User
- **Endpoint**: `POST /auth/login`
- **Body**:
  ```json
  {
    "email": "alice@metaverse.com",
    "password": "password123"
  }
  ```
- **Response (`200 OK`)**: Same as register.

#### 3. Get Current Profile
- **Endpoint**: `GET /auth/me`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Response (`200 OK`)**: User object (including `avatar`).

#### 4. Update Avatar
- **Endpoint**: `PATCH /auth/avatar`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Body**:
  ```json
  {
    "avatar": "avatar-2"
  }
  ```
- **Response (`200 OK`)**: Updated User object.

---

### Rooms Management

*All room endpoints require `Authorization: Bearer <accessToken>`.*

#### 4. Create Room
- **Endpoint**: `POST /rooms`
- **Body**:
  ```json
  {
    "name": "Town Hall",
    "maxPlayers": 25,
    "width": 1000,
    "height": 1000,
    "spawnX": 500,
    "spawnY": 500,
    "zones": [
      {
        "id": "zone-pod-alpha",
        "name": "Meeting Pod Alpha",
        "x": 100,
        "y": 100,
        "width": 250,
        "height": 200
      }
    ]
  }
  ```
*(Note: If `zones` is omitted, server auto-provisions two default meeting spaces: "Meeting Pod Alpha" and "Executive Lounge")*
- **Response (`201 Created`)**:
  ```json
  {
    "id": "room-uuid",
    "name": "Town Hall",
    "inviteCode": "A3F9B1",
    "createdById": "user-uuid",
    "maxPlayers": 25,
    "width": 1000,
    "height": 1000,
    "spawnX": 500,
    "spawnY": 500,
    "zones": [...],
    "createdAt": "..."
  }
  ```

#### 5. Join Room by Invite Code
- **Endpoint**: `POST /rooms/join`
- **Body**:
  ```json
  {
    "inviteCode": "A3F9B1"
  }
  ```
- **Response (`201 Created`)**:
  ```json
  {
    "message": "Joined room successfully",
    "roomId": "room-uuid",
    "roomName": "Town Hall",
    "role": "MEMBER"
  }
  ```

#### 6. List My Rooms
- **Endpoint**: `GET /rooms/my`
- **Response (`200 OK`)**: Array of rooms the authenticated user belongs to.

#### 7. Get Room Details by ID
- **Endpoint**: `GET /rooms/:id`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Authorization**: Caller must be a member of the room. Returns `403 Forbidden` if user is not a member.
- **Response (`200 OK`)**: Room metadata, dimensions, spawn points, meeting zones, obstacle collision boxes, creator, and current members list.

#### 8. Update Room (OWNER Only)
- **Endpoint**: `PATCH /rooms/:id`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Body** (all fields optional):
  ```json
  {
    "name": "Upgraded Town Hall",
    "width": 1500,
    "height": 1200,
    "maxPlayers": 50
  }
  ```
- **Response (`200 OK`)**: Updated Room object.
- **Side Effect**: Emits `room:updated` over Socket.IO to all connected players.

#### 9. Delete Room (OWNER Only)
- **Endpoint**: `DELETE /rooms/:id`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Response (`200 OK`)**:
  ```json
  {
    "message": "Room deleted successfully",
    "roomId": "room-uuid"
  }
  ```
- **Side Effect**: Broadcasts `room:deleted` with `{ roomId, reason: "The room has been deleted by the owner" }` to all active sockets in the room, purges server memory, and forcibly kicks all sockets from the room channel.

#### 10. Leave Room (Non-Owner Members)
- **Endpoint**: `POST /rooms/:id/leave`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Response (`200 OK`)**:
  ```json
  {
    "message": "Left room successfully",
    "roomId": "room-uuid"
  }
  ```
- **Error (`400 Bad Request`)**: Room owner cannot leave their own room (must delete room or transfer ownership).
- **Side Effect**: Removes user from in-memory room state and broadcasts `player:left` to remaining peers.

#### 11. Regenerate Invite Code (OWNER & MODERATOR)
- **Endpoint**: `POST /rooms/:id/regenerate-invite`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Response (`200 OK`)**:
  ```json
  {
    "message": "Invite code regenerated successfully",
    "inviteCode": "K8X2M9"
  }
  ```

#### 12. Kick Member (OWNER or MODERATOR)
- **Endpoint**: `DELETE /rooms/:id/members/:memberId`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Hierarchy Rules**:
  - `OWNER` can kick `MODERATOR` and `MEMBER`.
  - `MODERATOR` can kick `MEMBER` (cannot kick other `MODERATOR`s or `OWNER`).
  - Cannot kick the room `OWNER`.
  - Cannot kick oneself.
- **Response (`200 OK`)**:
  ```json
  {
    "message": "Member kicked successfully",
    "roomId": "room-uuid",
    "memberId": "target-user-uuid"
  }
  ```
- **Side Effect**:
  - Kicked player's socket receives `player:kicked` with reason and is evicted from room channel.
  - Their WebRTC proximity peers receive `proximity:leave`.
  - Remaining players in room receive `player:left` with `{ userId, reason: "kicked" }`.

#### 13. Update Member Role (OWNER Only)
- **Endpoint**: `PATCH /rooms/:id/members/:memberId/role`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Body**:
  ```json
  {
    "role": "MODERATOR"
  }
  ```
- **Allowed values**: `"MODERATOR"`, `"MEMBER"`
- **Response (`200 OK`)**:
  ```json
  {
    "message": "Member role updated successfully",
    "roomId": "room-uuid",
    "memberId": "target-user-uuid",
    "role": "MODERATOR"
  }
  ```
- **Side Effect**: Broadcasts `room:member-role-updated` to all active sockets in the room.

---

### Chat History

#### 14. Get Public Room Messages
- **Endpoint**: `GET /rooms/:roomId/messages?limit=50`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Response (`200 OK`)**: Array of general room chat messages.

#### 15. Get 1-on-1 Direct Message (DM) History
- **Endpoint**: `GET /rooms/:roomId/messages/dm/:peerId?limit=50`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Response (`200 OK`)**:
  ```json
  [
    {
      "id": "msg-uuid",
      "roomId": "room-uuid",
      "senderId": "alice-uuid",
      "recipientId": "bob-uuid",
      "content": "Hey Bob, let's sync in Pod Alpha",
      "createdAt": "2026-10-25T...",
      "sender": { "id": "alice-uuid", "displayName": "Alice" },
      "recipient": { "id": "bob-uuid", "displayName": "Bob" }
    }
  ]
  ```

#### 16. Get Meeting Pod / Zone Chat History
- **Endpoint**: `GET /rooms/:roomId/messages/zone/:zoneId?limit=50`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Response (`200 OK`)**:
  ```json
  [
    {
      "id": "msg-uuid",
      "roomId": "room-uuid",
      "zoneId": "zone-pod-alpha",
      "senderId": "alice-uuid",
      "content": "Here is the presentation deck link",
      "createdAt": "2026-10-25T...",
      "sender": { "id": "alice-uuid", "displayName": "Alice" }
    }
  ]
  ```

---

## 4. Real-Time Socket.IO Protocol

### Connection Handshake
The client **must** pass the JWT in the `auth` payload during connection:
```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: {
    token: accessToken // JWT from login/register
  }
});
```

---

### Socket Event Contracts

#### 1. Join Virtual Room
* **Client emits**: `room:join`
  ```json
  { "roomId": "room-uuid" }
  ```
* **Server responds (Ack / Return)**:
  ```json
  {
    "success": true,
    "roomId": "room-uuid",
    "player": {
      "userId": "user-uuid",
      "displayName": "Alice",
      "avatar": "avatar-1",
      "x": 500,
      "y": 500,
      "direction": "down"
    }
  }
  ```
* **Server emits to joining client**: `room:state` (Snapshot of room configuration, private zones, obstacles, and all active players)
  ```json
  {
    "roomId": "room-uuid",
    "width": 2000,
    "height": 2000,
    "spawnX": 1000,
    "spawnY": 860,
    "zones": [
      {
        "id": "zone-pod-alpha",
        "name": "Design Room",
        "x": 450,
        "y": 150,
        "width": 1100,
        "height": 640
      }
    ],
    "obstacles": [
      {
        "id": "wall-top",
        "x": 0,
        "y": 0,
        "width": 2000,
        "height": 32
      }
    ],
    "players": [
      {
        "userId": "bob-uuid",
        "displayName": "Bob",
        "avatar": "avatar-2",
        "x": 1000,
        "y": 860,
        "direction": "down",
        "currentZoneId": null,
        "nearbyPeers": [],
        "isScreenSharing": false
      }
    ]
  }
  ```
* **Server broadcasts to others in the room**: `player:joined`
  ```json
  {
    "userId": "alice-uuid",
    "displayName": "Alice",
    "avatar": "avatar-1",
    "x": 500,
    "y": 500,
    "direction": "down"
  }
  ```

---

#### 2. Zone Entered / Left (Private Meeting Space Feedback)
* **Server emits to player**: `zone:entered`
  ```json
  {
    "zoneId": "zone-pod-alpha",
    "zoneName": "Meeting Pod Alpha"
  }
  ```
* **Server emits to player**: `zone:left`
  ```json
  {
    "zoneId": "zone-pod-alpha"
  }
  ```
* **Frontend Handling**: Display toast / banner indicating private meeting status.

---

#### 3. Avatar Update
* **Client emits**: `player:update-avatar`
  ```json
  {
    "avatar": "avatar-3"
  }
  ```
* **Server broadcasts to room**: `player:avatar-updated`
  ```json
  {
    "userId": "alice-uuid",
    "avatar": "avatar-3"
  }
  ```

---

#### 4. Player Movement
* **Client emits**: `player:move`
  ```json
  {
    "x": 510,
    "y": 500,
    "direction": "right"
  }
  ```
* **Server broadcasts to others**: `player:moved`
  ```json
  {
    "userId": "alice-uuid",
    "x": 510,
    "y": 500,
    "direction": "right",
    "currentZoneId": "zone-pod-alpha",
    "timestamp": 1700000000000
  }
  ```
*(Note: If coordinates exceed map bounds or teleportation is detected, server returns `{ success: false, correctedPosition: { x, y } }`)*

---

#### 5. Player Disconnection
* **Server broadcasts to others**: `player:left`
  ```json
  {
    "userId": "alice-uuid"
  }
  ```

---

#### 6. Teams-Style 1-on-1 Direct Message (DM)
* **Client emits**: `chat:dm`
  ```json
  {
    "recipientId": "bob-uuid",
    "content": "Hey Bob, let's sync in Pod Alpha"
  }
  ```
* **Server relays ONLY to recipient and sender socket**: `chat:dm`
  ```json
  {
    "id": "msg-uuid",
    "roomId": "room-uuid",
    "senderId": "alice-uuid",
    "senderName": "Alice",
    "recipientId": "bob-uuid",
    "content": "Hey Bob, let's sync in Pod Alpha",
    "createdAt": "2026-10-25T..."
  }
  ```

---

#### 7. Private Meeting Zone Chat
* **Client emits**: `chat:zone` (Player must be inside a meeting zone)
  ```json
  {
    "content": "Meeting agenda: Q4 goals"
  }
  ```
* **Server relays ONLY to players inside that same zone**: `chat:zone`
  ```json
  {
    "id": "msg-uuid",
    "roomId": "room-uuid",
    "zoneId": "zone-pod-alpha",
    "senderId": "alice-uuid",
    "senderName": "Alice",
    "content": "Meeting agenda: Q4 goals",
    "createdAt": "2026-10-25T..."
  }
  ```

---

#### 8. Commons Room Chat (Fallback / General)
* **Client emits**: `chat:send`
  ```json
  {
    "content": "Hello world!"
  }
  ```
* **Server broadcasts to everyone in room**: `chat:message`
  ```json
  {
    "id": "msg-uuid",
    "roomId": "room-uuid",
    "senderId": "alice-uuid",
    "senderName": "Alice",
    "content": "Hello world!",
    "createdAt": "2026-10-25T..."
  }
  ```

---

#### 5. Room Deleted / Eviction Notice
* **Server broadcasts to room**: `room:deleted`
  ```json
  {
    "roomId": "room-uuid",
    "reason": "The room has been deleted by the owner"
  }
  ```
* **Frontend Handling**:
  - Show modal / notification: *"The room has been deleted by the owner"*.
  - Disconnect WebRTC audio/video tracks.
  - Redirect player back to dashboard / room list (`/rooms` or `/dashboard`).

---

#### 6. Room Updated Notice
* **Server broadcasts to room**: `room:updated`
  ```json
  {
    "roomId": "room-uuid",
    "name": "New Room Title",
    "width": 1500,
    "height": 1200,
    "maxPlayers": 50
  }
  ```
* **Frontend Handling**: Update canvas viewport boundaries and room header dynamically without requiring a page reload.

---

#### 7. Player Kicked Notice (Sent to target client)
* **Server emits directly to kicked client**: `player:kicked`
  ```json
  {
    "roomId": "room-uuid",
    "reason": "You have been kicked from the room by a moderator or owner"
  }
  ```
* **Frontend Handling**:
  - Display alert or toast: *"You have been kicked from this room."*
  - Close all active WebRTC peer connections.
  - Redirect player back to `/dashboard`.

---

#### 8. Member Role Updated Notice
* **Server broadcasts to room**: `room:member-role-updated`
  ```json
  {
    "roomId": "room-uuid",
    "userId": "target-user-uuid",
    "role": "MODERATOR"
  }
  ```
* **Frontend Handling**: Update the participant list badge / permissions in the UI in real time.

---

## 5. WebRTC Proximity Audio/Video Protocol

### Gather.town 2-Tier Proximity Hierarchy

The backend evaluates real-time peer proximity using a **soundproof zone hierarchy**:

1. **Private Meeting Pods (Soundproof Isolation)**:
   - When Player A and Player B are **both inside the same private meeting zone** (e.g. `zone-pod-alpha`), `proximity:enter` is automatically triggered.
   - Anyone standing outside that private zone (even $5\text{px}$ away outside the boundary) **cannot** hear or see them.
2. **Commons / Public Hallways**:
   - When both players are outside any private meeting zone, standard **$150\text{px}$ Euclidean distance** triggers `proximity:enter` and `proximity:leave`.

#### `proximity:enter` (Server $\rightarrow$ Client)
Sent when another player enters audio/video range:
```json
{
  "peerId": "bob-uuid",
  "displayName": "Bob",
  "zoneId": "zone-pod-alpha",
  "distance": 84
}
```

#### `proximity:distance` (Server $\rightarrow$ Client)
Sent continuously as players move within proximity range ($0$ to $150\text{px}$) for smooth audio volume attenuation:
```json
{
  "peerId": "bob-uuid",
  "distance": 62
}
```
*Frontend Formula*:
```ts
const volume = Math.max(0, Math.min(1, 1 - distance / 150));
peerAudioElement.volume = volume;
```

#### `proximity:leave` (Server $\rightarrow$ Client)
Sent when that player walks farther than 150px away, exits the private zone, or disconnects:
```json
{
  "peerId": "bob-uuid"
}
```
*Action: Close the `RTCPeerConnection` for this `peerId` and remove their video/audio stream from the DOM.*

#### `webrtc:peer-disconnected` (Server $\rightarrow$ Client)
Sent immediately on player disconnect, kick, or room-switch to tear down WebRTC connections without waiting for ICE timeouts:
```json
{
  "peerId": "bob-uuid"
}
```

---

#### 3. Pod Presence Notifications
* **Server emits to peers inside the zone**: `zone:peer-entered`
  ```json
  {
    "userId": "alice-uuid",
    "displayName": "Alice",
    "zoneId": "zone-pod-alpha"
  }
  ```
* **Server emits to peers inside the zone**: `zone:peer-left`
  ```json
  {
    "userId": "alice-uuid",
    "displayName": "Alice",
    "zoneId": "zone-pod-alpha"
  }
  ```

---

### WebRTC Signaling Events

#### Who creates the Offer? (Glare Prevention Rule)
When `proximity:enter` fires, to prevent both browsers from creating offers simultaneously:
* **The player with the lexicographically smaller `userId` initiates the call (`createOffer`).**
* Example: If `"alice-id" < "bob-id"`, Alice calls `createOffer()`; Bob waits for Alice's offer.

#### 1. SDP Offer
* **Client A emits**: `webrtc:offer`
  ```json
  {
    "targetUserId": "bob-uuid",
    "sdp": { "type": "offer", "sdp": "v=0..." }
  }
  ```
* **Server relays to Client B**: `webrtc:offer`
  ```json
  {
    "fromUserId": "alice-uuid",
    "sdp": { "type": "offer", "sdp": "v=0..." }
  }
  ```

#### 2. SDP Answer
* **Client B emits**: `webrtc:answer`
  ```json
  {
    "targetUserId": "alice-uuid",
    "sdp": { "type": "answer", "sdp": "v=0..." }
  }
  ```
* **Server relays to Client A**: `webrtc:answer`
  ```json
  {
    "fromUserId": "bob-uuid",
    "sdp": { "type": "answer", "sdp": "v=0..." }
  }
  ```

#### 3. ICE Candidates
* **Client emits**: `webrtc:ice-candidate`
  ```json
  {
    "targetUserId": "target-uuid",
    "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 }
  }
  ```
* **Server relays**: `webrtc:ice-candidate`
  ```json
  {
    "fromUserId": "source-uuid",
    "candidate": { ... }
  }
  ```

> [!IMPORTANT]
> **ICE Candidate Queuing Rule for Frontend**:
> In WebRTC, ICE candidates can arrive over WebSockets *before* `setRemoteDescription()` finishes executing. The frontend client **must queue incoming candidates** in an array and add them only after `setRemoteDescription()` resolves!

#### 4. Screen Sharing
* **Client emits**: `screen:share-toggle`
  ```json
  { "isSharing": true }
  ```
* **Server relays to nearby peers**: `screen:user-sharing`
  ```json
  {
    "userId": "alice-uuid",
    "isSharing": true
  }
  ```

---

## 6. Frontend Quick-Start Checklist

1. **Bootstrap**: Vite + React + TypeScript + Tailwind CSS + Phaser 3.
2. **State Store**: Zustand or React Context for managing JWT, current user profile, room metadata, active players map, and WebRTC peer connections.
3. **Phaser Canvas**:
   - Create a Phaser Game Scene (`width: 1000, height: 1000`).
   - Spawn local player sprite at `(500, 500)`.
   - On `player:moved`, lerp/interpolate other avatars smoothly.
4. **WebRTC Media Manager**:
   - `navigator.mediaDevices.getUserMedia({ audio: true, video: true })`
   - Maintain `Map<peerId, RTCPeerConnection>`.
   - On `proximity:enter`, create peer connection with Google public STUN servers:
     ```javascript
     const pc = new RTCPeerConnection({
       iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
     });
     ```
   - On `track` event, attach remote stream to a `<video>` or `<audio>` element.
