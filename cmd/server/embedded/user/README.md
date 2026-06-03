User frontend assets are copied here by scripts/build-packages.sh before building
the server binary. When this directory only contains this placeholder, the server
falls back to loading user-frontend/dist from disk.
