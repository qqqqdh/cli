---
name: write-tests
description: >
  Add focused tests for a function, module or bug fix using the project's
  existing test framework. Use for "write tests", "테스트 추가", "add coverage".
argument-hint: "<file or function>"
---

# Write tests

Target: $ARGUMENTS

1. Detect the test setup: `glob` for existing tests (`**/*.test.*`, `**/test_*.py`, `**/*_test.go`)
   and find the test command in package.json / pyproject / Makefile. Follow their style, location and naming.
   With no framework, use the language's built-in one (node:test, unittest, go test).
2. Read the target code. List behaviors worth testing: normal case, edge cases (empty, zero, boundaries),
   error cases, and any bug being fixed (that test must fail without the fix).
3. Write a few small, independent tests. No mocking unless I/O makes it necessary.
4. Run the tests. If a test was wrong, fix the test; if the code is wrong, report it.

Report what is covered, the command to run the tests, and what remains untested.
