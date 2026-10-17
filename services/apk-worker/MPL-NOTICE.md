# Source and modification notice

This worker incorporates selected files from Suwayomi-Server v2.3.2243. Files
covered by the Mozilla Public License 2.0 retain their upstream notices and terms;
the complete worker is not represented as solely Apache-2.0 software.

The BOAA build modifies the Android preference compatibility methods in
`Preference.java`, `TwoStatePreference.java` and `ListPreference.java` and adds the
BOAA compatibility/worker sources. `build.py` contains the exact transformations,
upstream source URL and SHA-256. Existing per-file terms continue to apply.

The exact modified sources are in `/payload/runtime/source`, with the build recipe
and Maven dependency lock in `/payload/runtime/build-recipe`. Final-image source
archives are also release assets named `apk-<architecture>-embedded-sources.tar.gz`.
The original source archive is in `boaa-server-sources.tar.gz`. Rebuild with the
supplied recipe and JDK 21; see `third_party/server-sources.md`. These source files
can be obtained under MPL 2.0, independently of BOAA's Apache-2.0 host license.
