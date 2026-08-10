# Legacy upgrade acceptance fixture

The Windows workflow checks out former application source
`e36ec72ae8c53b0f9af7eeb0ef3f605b9f5dab9a` to test a real version 1.0.0 schema and executable
against version 1.1.0. That immutable source has one historical reproducibility defect: its
`Cargo.toml` pins `uuid = 1.18.1`, while its committed `Cargo.lock` records `uuid = 1.24.0`.

`legacy-e36ec72-Cargo.lock` is the reviewable package-manager output produced from that exact
manifest and original lock with pinned Cargo 1.89.0:

```text
cargo update --manifest-path Cargo.toml -p uuid --precise 1.18.1
```

The update downgrades `uuid` to the manifest's exact version and removes only its now-unused
`getrandom 0.4.3` and `r-efi 6.0.0` dependencies. It does not change the former application source.

| Evidence                                 | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Immutable source's original `Cargo.lock` | `dfcfa8ee77e3d1139beefcde2f9f631bace818ed7a25cf5ac07863c23b44a8cb` |
| Reviewed reproducibility fixture         | `7bbe908f540455eb673274bc8e014b80b06a16b460ac781fca60f1c6169154e9` |

CI also pins the original Git blob `562495d1fc7c3189d56859b0232d92b2c27a95b9` and fixture blob
`49f021514c1fed112293b56d15bddfc2d1931613`. It verifies all four identities before substitution,
builds with `--locked`, verifies the fixture hash again after packaging, and rejects every other
tracked change. It records the source SHA and both lock identities in the diagnostic evidence. The
fixture is acceptance-only and is not used by the current application build.

`cargo-audit 0.22.2` reported no vulnerability failure for the fixture against 1,190 loaded RustSec
advisories. It reported the same 17 unsuppressed transitive warnings documented for the current
lock: ten unmaintained GTK3 bindings, unmaintained `proc-macro-error`, five unmaintained `unic-*`
crates, and the `glib 0.18.5` unsoundness advisory.
