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
