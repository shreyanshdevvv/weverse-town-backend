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
    "displayName": "Alice"
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
- **Response (`200 OK`)**: User object.

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
    "height": 1000
  }
  ```
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
- **Response (`200 OK`)**: Room metadata, dimensions, creator, and current members.

---

### Chat History

#### 8. Get Recent Room Messages
- **Endpoint**: `GET /rooms/:roomId/messages?limit=50`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Response (`200 OK`)**:
  ```json
  [
    {
      "id": "msg-uuid",
      "roomId": "room-uuid",
      "senderId": "user-uuid",
      "content": "Hey everyone!",
      "createdAt": "2026-10-25T...",
      "sender": {
        "id": "user-uuid",
        "displayName": "Alice"
      }
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
      "x": 500,
      "y": 500,
      "direction": "down"
    }
  }
  ```
* **Server emits to joining client**: `room:state` (Snapshot of all active players in room)
  ```json
  {
    "roomId": "room-uuid",
    "width": 1000,
    "height": 1000,
    "players": [
      {
        "userId": "bob-uuid",
        "displayName": "Bob",
        "x": 450,
        "y": 500,
        "direction": "down",
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
    "x": 500,
    "y": 500,
    "direction": "down"
  }
  ```

---

#### 2. Player Movement
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
    "timestamp": 1700000000000
  }
  ```
*(Note: If coordinates exceed map bounds or teleportation is detected, server returns `{ success: false, correctedPosition: { x, y } }`)*

---

#### 3. Player Disconnection
* **Server broadcasts to others**: `player:left`
  ```json
  {
    "userId": "alice-uuid"
  }
  ```

---

#### 4. Text Chat
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

## 5. WebRTC Proximity Audio/Video Protocol

### Proximity Triggers (Distance Threshold: 150px)

The backend triggers connection and teardown automatically based on avatar coordinates:

#### `proximity:enter` (Server $\rightarrow$ Client)
Sent when another player enters within 150px range:
```json
{
  "peerId": "bob-uuid",
  "displayName": "Bob"
}
```

#### `proximity:leave` (Server $\rightarrow$ Client)
Sent when that player walks farther than 150px away or disconnects:
```json
{
  "peerId": "bob-uuid"
}
```
*Action: Close the `RTCPeerConnection` for this `peerId` and remove their video/audio stream from the DOM.*

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
