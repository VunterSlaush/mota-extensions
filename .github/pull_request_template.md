<!--
Adding or updating an extension? Keep the checklist. Fixing a typo in the
docs? Delete it and just say what you changed.
-->

## What this adds

<!-- One or two sentences. What does it do, and for whom? -->

## Permissions

<!-- One line per permission in the manifest, saying why it is needed.
     Write "none" if the manifest declares none. -->

## Network

<!-- Which hosts does it talk to, and what does it send? "None" is a
     great answer. -->

## Checklist

- [ ] `node scripts/validate.mjs` passes
- [ ] `node scripts/build-readme.mjs` run and the catalog committed
- [ ] The entry in `registry.json` matches the manifest
- [ ] The extension folder has a README covering setup and permissions
- [ ] I installed it from this branch, approved it in Mota, and used it
- [ ] No secrets, no `node_modules/`, no build step
