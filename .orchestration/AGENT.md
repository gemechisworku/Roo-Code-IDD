# Shared Brain - Agent Knowledge Base

This file contains lessons learned, architectural decisions, and project-specific rules shared across all agent sessions.

## Architectural Principles

### Intent-Driven Development

- All code changes must be tied to a formal intent in `.orchestration/active_intents.yaml`
- Never write code without first calling `select_active_intent(intent_id)`
- Respect scope boundaries defined in intent specifications

### Code Quality Standards

- All functions must have JSDoc comments
- Error handling must be comprehensive
- Unit tests required for all business logic
- Integration tests required for API changes

## Lessons Learned

### Authentication Migration (INT-001)

- **Lesson**: Always check for backward compatibility before removing old auth methods
- **Impact**: Prevented breaking existing client applications
- **Action**: Added feature flags for gradual migration

### Database Connection Issues

- **Lesson**: Connection pooling requires careful configuration of timeouts
- **Impact**: Fixed memory leaks and improved performance under load
- **Action**: Implemented proper connection lifecycle management

### API Design Patterns

- **Lesson**: RESTful APIs should use consistent HTTP status codes
- **Impact**: Improved client error handling
- **Action**: Created shared error response utilities

## Coding Patterns

### Error Handling

```typescript
try {
	// Business logic
} catch (error) {
	logger.error("Operation failed", { error, context })
	throw new BusinessError("User-friendly message", error)
}
```

### Database Operations

```typescript
const connection = await getConnection()
try {
	// Database operations
	await connection.commit()
} finally {
	connection.release()
}
```

## Performance Guidelines

- Database queries should complete within 100ms
- API responses should be under 500ms
- Memory usage should not exceed 512MB per process
- Connection pools should maintain 10-20 connections

## Security Requirements

- All user inputs must be validated
- SQL injection prevention required
- HTTPS only for production
- JWT tokens must expire within 24 hours
- Password hashing with bcrypt (min cost 12)

## Testing Standards

- Unit test coverage > 80%
- Integration tests for all API endpoints
- Load testing for performance-critical paths
- Security testing for authentication flows

---

_This file is automatically updated when agents encounter failures or make architectural decisions._

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-20T15:56:33.377Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_lock.txt
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: 1c69779f4d6d13514726491273ceade5f975a9973f99f6b00e0db405c56139fb

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-20T16:06:13.136Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_lock.txt
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: a5406fc126c2bf45b47433c7b2676cce32321fd95d9c67a7dff067249abdb712

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-20T16:07:27.737Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_lock.txt
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: a5406fc126c2bf45b47433c7b2676cce32321fd95d9c67a7dff067249abdb712

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-20T16:28:34.443Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: dba5166ad9db9ba648c1032ebbd34dcd0d085b50023b839ef5c68ca1db93a563
- **Actual Hash**: b9bf72ed7e5d3043317727b3f7d75c474fd448df2c16cc88b236480e00c22989

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-20T16:51:48.789Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: 93452cf60aef7cc3c70ee5ca831488d7994b53573b147de3c5bace536c86ee54

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-20T16:53:24.727Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 96fece6ec6d00e13c861cccf6b6a75ce1bff269feba61c86f069ec1909fab4ab
- **Actual Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-20T16:55:48.065Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: 664ceddef20146a4ef2319249f3a50e358982ab884d564c86661cb4e7e8895d4

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-21T08:47:22.678Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: 76d775af7fbf002d3109d472586f1bc9fd97a7948ba68aa05c2ad95623359a0c

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-21T08:47:57.864Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: 3e68900e52410d0791ea7a2a414f6b05032f671ca2054194a49522d617cd116d

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-21T08:48:31.270Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: 3e68900e52410d0791ea7a2a414f6b05032f671ca2054194a49522d617cd116d

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-21T08:55:10.958Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: 6c2e4f2b9141279536d3159a28bf452492cef78df2916a6ca7b89cb82358c2f5

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-21T09:06:11.083Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: 3e68900e52410d0791ea7a2a414f6b05032f671ca2054194a49522d617cd116d

### Verification Failure (INT-001)

- **Timestamp**: 2026-02-21T09:17:58.472Z
- **Tool**: apply_patch
- **Path**: src/auth/\_qa_patch.ts
- **Lesson**: The file changed between read and write. Refresh context and retry the change.
- **Expected Hash**: 7eb70257593da06f682a3ddda54a9d260d4fc514f645237f5ca74b08f8da61a6
- **Actual Hash**: 5ab1f73c2795d64367f3ae427f444287e250f8b8c26e9d5aa9aaa886190de081
