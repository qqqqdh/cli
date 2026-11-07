---
name: image-reader
description: >
  Read and understand images: screenshots, error dialogs, UI mockups, diagrams,
  charts, photos of documents, scanned text (OCR). Use when the user attaches or
  mentions an image file (.png .jpg .jpeg .webp .gif .bmp), says "이미지 읽어줘",
  "스크린샷 봐줘", "사진 속 글자", "OCR", "이 화면처럼 만들어줘", or "what's in this image".
argument-hint: "<image path> [question]"
---

# Image reader

Input: $ARGUMENTS

Images are read with the `view_image` tool, which sends the file to a local vision model
(the current model if it supports images, otherwise an installed one such as qwen2.5vl / gemma3 / llama3.2-vision).
Images the user attached to the message are already described inside `<attached_images>`; use that first.

## Steps

1. **Find the image.** If only a name or folder is given, use `glob` (e.g. `**/*.png`) to get the exact path.
2. **Ask a focused question.** Call `view_image` with `path` and a `question` that matches the goal:
   | Goal | question |
   |---|---|
   | OCR / text | "Transcribe all text exactly, keeping line breaks and layout." |
   | Error screenshot | "Transcribe the full error message, stack trace and the app/window name." |
   | UI to rebuild | "List every UI element top to bottom with position, text, colors and sizes." |
   | Diagram / chart | "List the nodes and arrows (from → to, labels)" / "Read every axis, series and value." |
   | Code screenshot | "Transcribe the code exactly, preserving indentation." |
3. **Several images** (before/after, multiple pages): call `view_image` once per image, then compare.
4. **Check uncertain parts.** Small or blurry text may be misread; if a detail matters, ask again with a narrower question
   ("What exactly is the number in the top-right corner?"). Say when something is unreadable instead of guessing.
5. **Act on it.** For an error, continue with the debug approach (grep the message in the code). For a UI, build it using the
   project's existing components. For text, return it as plain text or a markdown table.

If `view_image` says no vision model is installed, tell the user to run `ollama pull qwen2.5vl:7b`
(or `gemma3:4b` for less memory) and stop.

## Output
What the image shows that matters for the user's goal, transcribed text in a code block when exact text matters,
and what could not be read reliably.
