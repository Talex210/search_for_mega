# Project: Mega.nz Image Search UserScript

## Project Overview

This project is a UserScript for browsers (designed for Violentmonkey or Tampermonkey) that indexes images within a user's Mega.nz account and allows searching for them based on visual similarity. It calculates a perceptual hash for each image, stores this information using the script manager's built-in storage (Greasemonkey functions), and provides a user interface to scan the currently visible folder.

**Key Technologies:**

*   **JavaScript:** The core language for the UserScript.
*   **UserScript Engine:** Designed for Violentmonkey/Tampermonkey.
*   **GM Storage:** Uses Greasemonkey functions (`GM.setValue`, `GM.getValue`, `GM.listValues`) for persistent, client-side storage of the image index. This approach was chosen for its simplicity over IndexedDB for a key-value dataset.
*   **Perceptual Hashing:** A custom difference hash (dHash) algorithm is implemented directly in the script to generate a "fingerprint" of images, allowing for visual comparison.

## Building and Running

This is a UserScript and is not "built" in a traditional sense. To run it, you need to:

1.  **Install a UserScript Manager:** Install a browser extension like [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2.  **Install the Script:**
    *   Create a new UserScript in the manager's dashboard.
    *   Copy the entire content of `mega_nz.js` into the editor.
    *   Ensure the script has the required permissions (`@grant`) to use `GM.setValue`, `GM.getValue`, etc.
    *   Save the script.
3.  **Run the Script:**
    *   Navigate to `https://mega.nz/` or `https://mega.io/`.
    *   The script will automatically execute and display a "Scan Folder" button.

**Testing:**

*   Open the browser's developer console (F12).
*   The script logs its activity, such as startup, scanning progress, and final counts.
*   You can manually interact with the script's functions via the console, for example:
    *   `window.checkDB()`: To view all the files currently indexed in the database. It will print a table with the data.

## Development Conventions

The development process is outlined in `roadmap.md`. It follows a step-by-step approach, building features incrementally.

*   **Modularity:** The code is structured into logical sections for UI, database logic, hashing, and the core scanner.
*   **Asynchronous Code:** The script makes heavy use of `async/await` and Promises to handle storage operations and image processing without blocking the browser's main thread.
*   **Global Functions:** Key functions (like `checkDB`) are exposed on the `window` (or `unsafeWindow`) object for easy debugging and manual testing from the developer console.
