# Event-ingestion and alerting platform

EventForge is a Node event-ingestion and alerting platform. It accepts JSON events through an HTTP API, 
validates and stores them, processes work asynchronously, and evaluates rules to trigger notifications or 
webhooks. Built to explore production backend concerns: auth, PostgreSQL, queues, reliability, and observability.

This is a work in progress, I'm using AI to accelerate the project but I am coding myself too, and focusing 
on understanding every produced line and backend concepts used, like how to make system reliable and resilient, 
how to disallow various possible attacks etc, when and where to introduce rate limiting etc.
