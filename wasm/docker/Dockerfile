# The userland wasm/build-from-source.sh runs the toolchain release's native
# compiler in (native64.tar.gz: a linux/aarch64 `lean` that needs glibc >=
# 2.38, libstdc++ and libuv) and wasm/scripts/compile-pkg.py (python3).
# Nothing else: the lanes build no compiler and no runtime, so the release's
# own build image (release.json docker.*, emsdk, ~3 GB) is not needed.
#
# The lane builds this image on first use, for the record's native64
# platform (linux/arm64), and tags it lean4game-native64:<sha256 of this
# file, 12 hex> — edit this file and the next run builds a new tag. The base
# is pinned by its multi-arch index digest; the packages are Ubuntu 24.04's
# (the same distro, glibc 2.39 and Python 3.12 as the release's build image).
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 libuv1t64 libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
