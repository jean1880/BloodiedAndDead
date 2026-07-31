# Roll20 Mod: Bloodied and Dead

This project contains a Roll20 Mod (API) script designed to automate token status markers based on health bar values and uniquely randomize HP for new tokens.

## Architecture & Environment
- **Environment:** Roll20 API Sandbox (Server-side JavaScript).
- **Global Objects:** Access to `on`, `log`, `getObj`, `findObjs`, `createObj`, `_` (Underscore.js), and the `state` object.
- **Constraints:** No DOM access. Scripts run in a shared global namespace.
- **Encapsulation:** The script is wrapped in an Immediately Invoked Function Expression (IIFE) to prevent collisions with other scripts.
- **Persistence:** Uses `state.BloodiedAndDead` to store configuration (active bar, marker names, HP formula attribute) across sandbox restarts.

## Script Logic: BloodiedAndDead.js
- **Primary Function:** Monitors health and automates token markers.
- **HP Generation:** 
  - When a token is added to the map, the script looks for an HP formula attribute (default `npc_hpformula`).
  - It rolls the dice using Roll20's `randomInteger` and sets the token's bar `value` and `max` independently.
  - This ensures each token has a unique HP pool, even if dragged from the same character sheet.
- **Hardened Checks:** 
  - Validates that the object is a token.
  - Ensures health values are numeric and `max` is greater than 0 before processing.
  - Uses `try-catch` blocks in event handlers to prevent sandbox crashes.
- **Status Markers:**
  - **Bloodied:** Adds `status_redmarker` when HP <= 50% of Max HP.
  - **Dead:** Adds `status_dead` (big red X) when HP <= 0.
- **Commands:**
  - `!ChangeBar <bar1|bar2|bar3>`: Updates and persists which bar the script monitors.

## Development Workflow
1. **Testing:** Paste code into the Roll20 API Script Editor.
2. **Debugging:** Use the API Console to view `log()` output and `try-catch` error messages.
3. **Naming Conventions:**
   - Internal logic uses `const` (SCREAMING_SNAKE_CASE) and arrow functions.
   - Event handlers are encapsulated within the module.
4. **Validation:**
   - The script avoids redundant `obj.set()` calls by checking existing status values first.

## Future Improvements
- Add support for custom marker names via chat commands.
- Implement "Temporary HP" logic.
- Support for token-specific overrides.
- Add `!SetHPFormula` command to configure the attribute name via chat.
