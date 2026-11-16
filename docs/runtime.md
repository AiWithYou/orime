# Runtime and graph contract

The Rust process listens only on loopback. COMFY_URL is a fixed loopback HTTP endpoint (default http://127.0.0.1:8188). Canvas uses /canvas-api; /nodes embeds the actual ComfyUI frontend through the same-origin proxy. A tiny injected frontend extension supplies graph loading, serialization and exact widget updates. Node UI owns the editable workflow; API prompts are compiled by ComfyUI. Loading a new recipe is explicit; returning to canvas never reconstructs a graph. Unbound custom graphs retain all nodes and disable recipe controls until a new recipe is explicitly selected.

The server checks local Host/Origin and bounds request bodies. GUI shutdown requires an explicit matching origin. On Windows each launch has its own process record. The GUI stops its own launch; the stop script stops all launcher-owned sessions in the installation. Cancellation uses the atomic `/api/jobs/{id}/cancel` endpoint. Submitted graphs and returned output references are kept in local job records. PreviewImage temporary outputs are displayed, but require downloading for durable retention.

The UI uses a compact desktop inspector: 40px header, 288px inspector, 40px icon tools, central image area, 144px history and 24px status. Controls are 28px high with persistent 12px labels; steps/CFG share a row, scalar labels sit beside inputs, and prompt text retains its own multiline area. The generation action stays visible in a single bottom row. Model selection is available above the prompt, not duplicated below the generation button. Brush size shares the canvas zoom strip. Focus rings and labelled icon buttons remain visible/accessible. Touch targets grow on mobile. Empty canvas has no fake outputs.

For MOSS editing with explicit output dimensions, the reference image is resized to those exact dimensions before encoding. Conditioning at a different resolution can shift/zoom the result relative to the source mask. Automatic edit dimensions retain the native 1MP reference-sizing workflow.

Adding an image to a new MOSS/Anima recipe switches untouched sampling defaults to the editing defaults. Explicitly changed values and existing node graphs are preserved. Canvas keyboard commands ignore composing text, repeated keys and editable elements for single-key tools; Ctrl+Enter generates and Ctrl+S saves only in Canvas mode.

Failed jobs show the failing node type and a bounded exception message, rather than only a generic failed badge. ControlNet weights, VAE and architecture must match; MiniMax H3 Fun video ControlNet is not interchangeable with the P-H3 image recipe.

The settings dialog offers image-based node templates for crop/super-resolution and SDXL Canny Control-LoRA. They use the current canvas image, save the existing graph before switching, validate required nodes/files, and open the real node editor. They never install models automatically.

## Common recipe operations

New recipes can insert a LoRA chain at the declared model/CLIP loader outputs and optionally scale decoded results before saving. These operations apply only when creating a recipe, never by guessing insertion points in an imported graph. Existing/custom graphs expose standard widget inputs directly. A scale factor of 1 leaves the output unchanged; a selected upscale model uses ComfyUI's UpscaleModelLoader/ImageUpscaleWithModel. LoRA compatibility still depends on the selected model architecture and weights.

## Mask semantics

The source RGB image and mask are uploaded separately so painted regions never destroy the input pixels. White/painted mask means edit. SDXL/Anima may use native mask conditioning. H3/MOSS do not accept a native mask: their edit is full-image conditioning, followed by an explicit masked composite. Final masked compositing keeps unpainted source pixels unchanged; it does not claim the model understood the mask. Generation outputs are resized to the original canvas dimensions before compositing.

## Recovery and explicit graph ownership

Saved jobs are displayed from disk even while ComfyUI is starting. On connection, Canvas reconciles outstanding jobs with ComfyUI. Large workflow histories do not require browser storage. Active jobs are polled frequently; missing jobs receive bounded retries and can be checked again on reconnection or reload. A successful cancellation is recorded for the selected job; known execution history takes precedence. An unacknowledged request with no history or queue entry remains unconfirmed.

Drafts retain bindings, pinned controls and image input references. Switching to another graph in the node editor clears the previous canvas image and mask. Saving or running a graph preserves image dimensions and other inputs wired in the node editor. Canvas updates only its own remaining editable inputs. Bridge requests are serialized to prevent overlapping graph loads and edits.

Restoring a canvas draft reloads the source and alpha mask from ComfyUI input storage. These files must remain available. Replacing a source updates only declared image bindings and the dimensions of the recipe-owned final composite. Clearing all paint on a masked recipe means editing the whole image on its next execution.

Save also preserves edits that have not been generated. A draft can contain settings and canvas image references without a workflow. Standard workflow exports store canvas metadata under `extra.aikimi`; before the first graph is created, exports use an `aikimiDraft` envelope. Both can be reopened by Canvas. Clicking the already active mode does nothing.

The model picker can preselect known compatible files already present in ComfyUI. Quantized MOSS/Anima and a paired P-H3 model/encoder are preferred when available. It never downloads weights or substitutes similarly named incompatible exports. User selections remain editable before a graph is created; unknown files remain available for explicit selection.

Anima 3.8B is a distinct extension architecture with an additional encoder and connector. It must not be preselected for the standard Anima recipe. Use its dedicated extension workflow in node mode.
Drafts marked needsCanvasCompile restore the image and mask without rebuilding an existing workflow. The user explicitly selects a new recipe to incorporate new image/mask topology; this preserves nodes added in ComfyUI. Drafts without a workflow compile normally on first submission.
