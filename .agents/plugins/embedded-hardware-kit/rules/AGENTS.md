# Embedded & Hardware Engineering Rules

1. **Evidence First**: Always inspect actual project artifacts (`.ioc` files, datasheets, schematics, netlists, BOMs, or source code) before asserting pinouts, peripheral multiplexing, register definitions, or component footprints.
2. **Zero Fabrication**: Never invent LCSC `Cxxxxxx` part numbers, IC pin numbers, pad mappings, or MCU register bitfields. Mark any unverified parameter explicitly as `[待核实]`.
3. **Safety Gates**:
   - Ask for confirmation before destructive EasyEDA Pro canvas operations (batch moves, net/track deletions, copper re-pours) or risky hardware/motor bring-up actions.
   - Always verify current limits, dead-time configuration, gate drive clamping, and hardware fault handling (`nFAULT` / timer `BKIN` break inputs) before enabling power stages.
