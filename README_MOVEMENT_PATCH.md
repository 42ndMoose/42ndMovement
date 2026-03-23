42ndMovement movement patch bundle

Drop these into your duplicate repo:
- index.html
- style.css
- src/main.js
- src/controller.js
- src/locomotion.js

What this patch changes
- keeps the current A/D strafe convention exactly as it already works in your repo
- turns sprint into a chained carry system, so higher sprint stages keep momentum and then fall off faster from higher values
- adds a locomotion panel that can load multiple GLB clips from the same rig
- strips common hips/root position tracks so Mixamo-style in-place locomotion works with controller-driven movement
- adds per-clip role mapping plus Preview, so numbered files like "sword and shield strafe (2).glb" can be tested without editing code
- leaves the emitter system and the rest of the repo alone

Suggested first pass for your current pack
- Character file: Paladin J Nordstrom.glb
- Idle: sword and shield idle.glb
- Walk: sword and shield walk.glb
- Run: sword and shield run.glb
- Jump / Air: sword and shield jump.glb
- Crouch Idle: sword and shield crouch idle.glb
- Crouch Move: sword and shield crouching.glb or sword and shield crouch.glb
- Strafe Left / Right: use Preview on the strafe files, then map the correct pair manually

Notes
- If a clip does not seem to bind, it usually means the skeleton names in that file do not match the current character rig.
- Generic numbered strafe clips cannot be inferred safely from filenames alone, so the patch gives you Preview and manual mapping instead of guessing wrong.
- This patch assumes the clips are in-place or close to it. It removes common root-motion tracks, but it does not do full retargeting between unrelated rigs.
