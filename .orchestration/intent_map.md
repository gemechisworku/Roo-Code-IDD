# Intent Spatial Map

This file maps high-level business intents to physical files and AST nodes. When a manager asks, "Where is the billing logic?", this file provides the answer.

## Active Intents

### INT-001: JWT Authentication Migration

**Status**: IN_PROGRESS
**Business Purpose**: Migrate from Basic Auth to JWT tokens for enhanced security
**Files**:

- `src/auth/middleware.ts` - Main authentication middleware
- `src/auth/jwt.ts` - JWT token handling
- `src/auth/types.ts` - Authentication type definitions

**Key Functions**:

- `authenticateUser()` - Main auth function
- `validateToken()` - JWT validation
- `refreshToken()` - Token refresh logic

### INT-002: User Profile API Enhancement

**Status**: PENDING
**Business Purpose**: Enhance user profile management with GDPR compliance
**Files**:

- `src/api/user/profile.ts` - Profile API endpoints
- `src/api/user/validation.ts` - Input validation
- `src/models/User.ts` - User data model

**Key Functions**:

- `getUserProfile()` - Retrieve user data
- `updateUserProfile()` - Update user information
- `deleteUserData()` - GDPR deletion

### INT-003: Database Connection Pooling

**Status**: PENDING
**Business Purpose**: Implement connection pooling for better performance
**Files**:

- `src/database/pool.ts` - Connection pool management
- `src/database/connection.ts` - Individual connections
- `src/config/database.ts` - Database configuration

**Key Functions**:

- `getConnection()` - Get pooled connection
- `releaseConnection()` - Return connection to pool
- `healthCheck()` - Pool health monitoring

## Intent Relationships

- INT-001 depends on INT-003 (auth needs database)
- INT-002 can be developed in parallel with INT-001
- All intents require proper testing and documentation updates
