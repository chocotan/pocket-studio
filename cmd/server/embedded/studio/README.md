Studio frontend assets are copied here by scripts/build-packages.sh before building
the server binary. When this directory only contains this placeholder, the server
falls back to loading studio-frontend/dist from disk.
