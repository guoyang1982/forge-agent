# Forge Mobile crypto v1 test vector

`test-vector.json` contains deterministic, public test-only key material. None of
the values are generated or used by a deployed Forge host or phone.

Every Node, React Native, and future native implementation must reproduce the
canonical transcript, X25519 shared secret, HKDF outputs, and sealed frame byte
for byte. Changing an expected value is a protocol change, not a test update.
