42ndMovement patch bundle

Replace these files in your duplicate repo:
- index.html
- style.css
- src/main.js
- src/controller.js
- src/audioEmitters.js
- src/assets.js
- src/utils.js

What changed:
- movement rewritten to keep sprint speed stable while camera yaw changes
- aim mode camera/body follow made much snappier
- character loader now auto-grounds feet and suggests a sane model scale
- model scale slider added
- emitters sit on the floor and the positional audio anchor is pinned to the visible source
- optional shared-track orbit panel added for synced multi-emitter playback

What I intentionally did not auto-wire:
- full generic locomotion blend-tree / retargeting from arbitrary external animation packs

Reason:
That is the part most likely to break a working repo without the exact rig, exact clip names, and the actual pack in hand.
