# Build with: docker build -f deploy/byedpi.Dockerfile --target artifact -t boaa-byedpi:0.17.3 .
# Static musl binary can be copied into the Debian Node API image without runtime packages.
FROM alpine:3.22 AS byedpi-build
RUN apk add --no-cache build-base linux-headers curl
WORKDIR /build
# Release v0.17.3. Verify the immutable upstream source archive before compilation.
ARG BYEDPI_REVISION=7efde1b1296eaaa187b70e951894dde17527489c
ARG BYEDPI_SOURCE_SHA256=ca696af46ebe22f81dae66531aa7fcb53a77d636ffbb5685e68d08f6e61ebcc1
RUN curl --fail --location --silent --show-error \
      "https://codeload.github.com/hufrea/byedpi/tar.gz/${BYEDPI_REVISION}" -o source.tar.gz \
    && echo "${BYEDPI_SOURCE_SHA256}  source.tar.gz" | sha256sum -c - \
    && mkdir source \
    && tar -xzf source.tar.gz --strip-components=1 -C source \
    && make -C source LDFLAGS=-static \
    && mkdir -p /output/usr/local/bin /output/usr/local/share/byedpi \
    && cp source/ciadpi /output/usr/local/bin/byedpi \
    && cp source/LICENSE source/README.md source.tar.gz /output/usr/local/share/byedpi/ \
    && apk info -v | sort > /output/usr/local/share/byedpi/build-packages.txt \
    && printf '%s\n%s\n' "${BYEDPI_REVISION}" "${BYEDPI_SOURCE_SHA256}" > /output/usr/local/share/byedpi/source-pin.txt

FROM scratch AS artifact
COPY --from=byedpi-build /output/ /
COPY deploy/byedpi.Dockerfile /usr/local/share/byedpi/build.Dockerfile
