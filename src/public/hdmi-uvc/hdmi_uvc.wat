(module
 (type $0 (func (result i32)))
 (type $1 (func (param i32 i32 i32 i32 i32 i32) (result i32)))
 (type $2 (func (param i32 i32) (result i32)))
 (type $3 (func (param i32) (result i32)))
 (type $4 (func (param i32 i32 i32 f32 f32 f32)))
 (type $5 (func (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
 (type $6 (func (param i32 i32 i32 i32 f64 f64 f64)))
 (type $7 (func (param i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 i32 i32) (result i32)))
 (type $8 (func (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
 (type $9 (func (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
 (global $wasm/hdmi-uvc/src/index/crcTableInit (mut i32) (i32.const 0))
 (memory $0 1 256)
 (export "crc32" (func $wasm/hdmi-uvc/src/index/crc32))
 (export "getScratchStart" (func $wasm/hdmi-uvc/src/index/getScratchStart))
 (export "getMemorySize" (func $wasm/hdmi-uvc/src/index/getMemorySize))
 (export "growMemory" (func $wasm/hdmi-uvc/src/index/growMemory))
 (export "classifyCompat4Cells" (func $wasm/hdmi-uvc/src/index/classifyCompat4Cells))
 (export "classifyLuma2Cells" (func $wasm/hdmi-uvc/src/index/classifyLuma2Cells))
 (export "packBinary1Payload" (func $wasm/hdmi-uvc/src/index/packBinary1Payload))
 (export "readLuma1Payload" (func $wasm/hdmi-uvc/src/index/readLuma1Payload))
 (export "probeExpectedPackets" (func $wasm/hdmi-uvc/src/index/probeExpectedPackets))
 (export "scanBrightRuns" (func $wasm/hdmi-uvc/src/index/scanBrightRuns))
 (export "memory" (memory $0))
 (func $wasm/hdmi-uvc/src/index/crc32 (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  global.get $wasm/hdmi-uvc/src/index/crcTableInit
  i32.eqz
  if
   loop $for-loop|0
    local.get $2
    i32.const 256
    i32.lt_u
    if
     local.get $2
     local.set $3
     i32.const 0
     local.set $4
     loop $for-loop|1
      local.get $4
      i32.const 8
      i32.lt_s
      if
       local.get $3
       i32.const 1
       i32.shr_u
       local.tee $5
       i32.const -306674912
       i32.xor
       local.get $5
       local.get $3
       i32.const 1
       i32.and
       select
       local.set $3
       local.get $4
       i32.const 1
       i32.add
       local.set $4
       br $for-loop|1
      end
     end
     local.get $2
     i32.const 2
     i32.shl
     local.get $3
     i32.store
     local.get $2
     i32.const 1
     i32.add
     local.set $2
     br $for-loop|0
    end
   end
   i32.const 1
   global.set $wasm/hdmi-uvc/src/index/crcTableInit
  end
  i32.const -1
  local.set $2
  i32.const 0
  local.set $3
  loop $for-loop|00
   local.get $1
   local.get $3
   i32.gt_u
   if
    local.get $0
    local.get $3
    i32.add
    i32.load8_u
    local.get $2
    i32.xor
    i32.const 255
    i32.and
    i32.const 2
    i32.shl
    i32.load
    local.get $2
    i32.const 8
    i32.shr_u
    i32.xor
    local.set $2
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|00
   end
  end
  local.get $2
  i32.const -1
  i32.xor
 )
 (func $wasm/hdmi-uvc/src/index/getScratchStart (result i32)
  i32.const 1040
 )
 (func $wasm/hdmi-uvc/src/index/getMemorySize (result i32)
  memory.size
 )
 (func $wasm/hdmi-uvc/src/index/growMemory (param $0 i32) (result i32)
  local.get $0
  memory.grow
 )
 (func $wasm/hdmi-uvc/src/index/classifyCompat4Cells (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32) (result i32)
  (local $6 f32)
  (local $7 i32)
  (local $8 f32)
  (local $9 i32)
  (local $10 f32)
  (local $11 f32)
  (local $12 i32)
  loop $for-loop|0
   local.get $4
   local.get $7
   i32.gt_u
   if
    local.get $3
    local.get $7
    i32.const 4
    i32.shl
    i32.add
    local.tee $9
    f32.load offset=8
    local.set $8
    local.get $9
    f32.load offset=12
    local.set $6
    local.get $5
    local.get $7
    i32.add
    block $__inlined_func$wasm/hdmi-uvc/src/index/sample2x2R$3 (result f32)
     local.get $9
     f32.load offset=4
     local.get $8
     f32.const 0.5
     f32.mul
     local.tee $10
     f32.add
     local.tee $11
     f32.ceil
     local.tee $8
     local.get $8
     f32.const -1
     f32.add
     local.get $8
     f32.const -0.5
     f32.add
     local.get $11
     f32.le
     select
     i32.trunc_sat_f32_s
     i32.const 1
     i32.sub
     local.set $12
     f32.const 0
     local.get $9
     f32.load
     local.get $10
     f32.add
     local.tee $8
     f32.ceil
     local.tee $10
     local.get $10
     f32.const -1
     f32.add
     local.get $10
     f32.const -0.5
     f32.add
     local.get $8
     f32.le
     select
     i32.trunc_sat_f32_s
     i32.const 1
     i32.sub
     local.tee $9
     local.get $12
     i32.or
     i32.const 0
     i32.lt_s
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/sample2x2R$3
     drop
     f32.const 0
     local.get $9
     i32.const 1
     i32.add
     local.get $1
     i32.ge_u
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/sample2x2R$3
     drop
     f32.const 0
     local.get $12
     i32.const 1
     i32.add
     local.get $2
     i32.ge_u
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/sample2x2R$3
     drop
     local.get $0
     local.get $12
     local.get $1
     i32.const 2
     i32.shl
     local.tee $12
     i32.mul
     i32.add
     local.get $9
     i32.const 2
     i32.shl
     i32.add
     local.tee $9
     local.get $12
     i32.add
     local.tee $12
     i32.load8_u offset=4
     local.get $12
     i32.load8_u
     local.get $9
     i32.load8_u
     local.get $9
     i32.load8_u offset=4
     i32.add
     i32.add
     i32.add
     f32.convert_i32_u
     f32.const 0.25
     f32.mul
    end
    local.get $6
    f32.ge
    i32.store8
    local.get $7
    i32.const 1
    i32.add
    local.set $7
    br $for-loop|0
   end
  end
  local.get $4
 )
 (func $wasm/hdmi-uvc/src/index/sampleQuadrants (param $0 i32) (param $1 i32) (param $2 i32) (param $3 f32) (param $4 f32) (param $5 f32)
  (local $6 f32)
  (local $7 f32)
  (local $8 f32)
  (local $9 f32)
  (local $10 f32)
  (local $11 f32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  (local $19 i32)
  (local $20 f32)
  (local $21 f32)
  local.get $3
  local.get $5
  f32.const 0.5
  f32.mul
  local.tee $6
  f32.add
  local.set $9
  local.get $4
  local.get $6
  f32.add
  local.set $8
  local.get $3
  local.get $5
  f32.add
  local.set $10
  local.get $4
  local.get $5
  f32.add
  local.set $11
  loop $for-loop|0
   local.get $17
   i32.const 4
   i32.lt_s
   if
    local.get $17
    if (result f32)
     local.get $17
     i32.const 1
     i32.eq
     if (result f32)
      local.get $4
      local.set $5
      local.get $10
      local.set $6
      local.get $8
      local.set $7
      local.get $9
     else
      local.get $17
      i32.const 2
      i32.eq
      if (result f32)
       local.get $8
       local.set $5
       local.get $9
       local.set $6
       local.get $11
       local.set $7
       local.get $3
      else
       local.get $8
       local.set $5
       local.get $10
       local.set $6
       local.get $11
       local.set $7
       local.get $9
      end
     end
    else
     local.get $4
     local.set $5
     local.get $9
     local.set $6
     local.get $8
     local.set $7
     local.get $3
    end
    local.tee $20
    f32.ceil
    local.tee $21
    local.get $21
    f32.const -1
    f32.add
    local.get $21
    f32.const -0.5
    f32.add
    local.get $20
    f32.le
    select
    i32.trunc_sat_f32_s
    local.tee $12
    i32.const 0
    i32.lt_s
    if
     i32.const 0
     local.set $12
    end
    local.get $5
    f32.ceil
    local.tee $20
    local.get $20
    f32.const -1
    f32.add
    local.get $20
    f32.const -0.5
    f32.add
    local.get $5
    f32.le
    select
    i32.trunc_sat_f32_s
    local.tee $14
    i32.const 0
    i32.lt_s
    if
     i32.const 0
     local.set $14
    end
    local.get $6
    f32.ceil
    local.tee $5
    local.get $5
    f32.const -1
    f32.add
    local.get $5
    f32.const -0.5
    f32.add
    local.get $6
    f32.le
    select
    i32.trunc_sat_f32_s
    local.tee $15
    local.get $1
    i32.gt_s
    if
     local.get $1
     local.set $15
    end
    local.get $15
    local.get $12
    i32.const 1
    i32.add
    local.tee $13
    i32.lt_s
    if
     local.get $13
     local.set $15
    end
    local.get $2
    local.get $7
    f32.ceil
    local.tee $5
    local.get $5
    f32.const -1
    f32.add
    local.get $5
    f32.const -0.5
    f32.add
    local.get $7
    f32.le
    select
    i32.trunc_sat_f32_s
    local.tee $16
    i32.lt_s
    if
     local.get $2
     local.set $16
    end
    local.get $16
    local.get $14
    i32.const 1
    i32.add
    local.tee $13
    i32.lt_s
    if
     local.get $13
     local.set $16
    end
    i32.const 0
    local.set $19
    i32.const 0
    local.set $18
    loop $for-loop|1
     local.get $14
     local.get $16
     i32.lt_s
     if
      local.get $12
      local.set $13
      loop $for-loop|2
       local.get $13
       local.get $15
       i32.lt_s
       if
        local.get $19
        local.get $0
        local.get $1
        local.get $14
        i32.mul
        i32.const 2
        i32.shl
        i32.add
        local.get $13
        i32.const 2
        i32.shl
        i32.add
        i32.load8_u
        i32.add
        local.set $19
        local.get $18
        i32.const 1
        i32.add
        local.set $18
        local.get $13
        i32.const 1
        i32.add
        local.set $13
        br $for-loop|2
       end
      end
      local.get $14
      i32.const 1
      i32.add
      local.set $14
      br $for-loop|1
     end
    end
    local.get $17
    i32.const 2
    i32.shl
    i32.const 1024
    i32.add
    local.get $18
    if (result f32)
     local.get $19
     f32.convert_i32_u
     local.get $18
     f32.convert_i32_u
     f32.div
    else
     f32.const 0
    end
    f32.store
    local.get $17
    i32.const 1
    i32.add
    local.set $17
    br $for-loop|0
   end
  end
 )
 (func $wasm/hdmi-uvc/src/index/classifyLuma2Cells (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32) (result i32)
  (local $6 f32)
  (local $7 i32)
  (local $8 i32)
  (local $9 f32)
  (local $10 f32)
  (local $11 f32)
  (local $12 f32)
  (local $13 f32)
  (local $14 f32)
  (local $15 f32)
  loop $for-loop|0
   local.get $4
   local.get $7
   i32.gt_u
   if
    local.get $3
    local.get $7
    i32.const 20
    i32.mul
    i32.add
    local.tee $8
    f32.load offset=12
    local.set $10
    local.get $8
    f32.load offset=16
    local.set $9
    local.get $0
    local.get $1
    local.get $2
    local.get $8
    f32.load
    local.get $8
    f32.load offset=4
    local.get $8
    f32.load offset=8
    call $wasm/hdmi-uvc/src/index/sampleQuadrants
    i32.const 1028
    f32.load
    local.set $11
    i32.const 1032
    f32.load
    local.set $12
    i32.const 1036
    f32.load
    local.set $6
    local.get $5
    local.get $7
    i32.add
    block $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$8 (result f32)
     f32.const 0
     f32.const 1
     f32.const -1
     local.get $9
     local.get $10
     f32.ge
     select
     local.tee $13
     i32.const 1024
     f32.load
     local.get $10
     f32.sub
     f32.mul
     f32.const 48
     local.get $9
     local.get $10
     f32.sub
     f32.abs
     local.tee $9
     local.get $9
     f32.const 48
     f32.lt
     select
     local.tee $14
     f32.div
     local.tee $9
     f32.const 0
     f32.lt
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$8
     drop
     f32.const 1
     local.get $9
     f32.const 1
     f32.gt
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$8
     drop
     local.get $9
    end
    local.tee $15
    block $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$9 (result f32)
     f32.const 0
     local.get $13
     local.get $11
     local.get $10
     f32.sub
     f32.mul
     local.get $14
     f32.div
     local.tee $9
     f32.const 0
     f32.lt
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$9
     drop
     f32.const 1
     local.get $9
     f32.const 1
     f32.gt
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$9
     drop
     local.get $9
    end
    local.tee $9
    f32.add
    f32.const 0.5
    f32.mul
    local.tee $11
    block $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$10 (result f32)
     f32.const 0
     local.get $13
     local.get $12
     local.get $10
     f32.sub
     f32.mul
     local.get $14
     f32.div
     local.tee $12
     f32.const 0
     f32.lt
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$10
     drop
     f32.const 1
     local.get $12
     f32.const 1
     f32.gt
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$10
     drop
     local.get $12
    end
    local.tee $12
    block $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$11 (result f32)
     f32.const 0
     local.get $13
     local.get $6
     local.get $10
     f32.sub
     f32.mul
     local.get $14
     f32.div
     local.tee $6
     f32.const 0
     f32.lt
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$11
     drop
     f32.const 1
     local.get $6
     f32.const 1
     f32.gt
     br_if $__inlined_func$wasm/hdmi-uvc/src/index/clamp01$11
     drop
     local.get $6
    end
    local.tee $6
    f32.add
    f32.const 0.5
    f32.mul
    local.tee $10
    f32.ge
    i32.eqz
    i32.const 2
    i32.const 3
    local.get $15
    local.get $12
    f32.add
    f32.const 0.5
    f32.mul
    local.tee $12
    local.get $9
    local.get $6
    f32.add
    f32.const 0.5
    f32.mul
    local.tee $6
    f32.ge
    select
    local.get $11
    local.get $10
    f32.sub
    f32.abs
    local.get $12
    local.get $6
    f32.sub
    f32.abs
    f32.ge
    select
    i32.store8
    local.get $7
    i32.const 1
    i32.add
    local.set $7
    br $for-loop|0
   end
  end
  local.get $4
 )
 (func $wasm/hdmi-uvc/src/index/packBinary1Payload (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32) (param $6 i32) (param $7 i32) (param $8 i32) (result i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 f32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  (local $19 i32)
  local.get $1
  i32.const 2
  i32.shl
  local.set $17
  loop $for-loop|0
   local.get $7
   local.get $9
   i32.gt_u
   local.get $6
   local.get $14
   i32.gt_u
   i32.and
   if
    local.get $3
    local.get $14
    i32.const 3
    i32.shl
    i32.add
    local.tee $10
    i32.load
    local.tee $12
    local.get $10
    i32.load offset=4
    local.tee $10
    i32.or
    i32.const 0
    i32.lt_s
    if
     i32.const 0
     return
    end
    local.get $2
    local.get $10
    i32.le_u
    if
     i32.const 0
     return
    end
    local.get $5
    local.get $12
    i32.add
    local.get $1
    i32.gt_u
    if
     i32.const 0
     return
    end
    local.get $4
    local.get $14
    i32.const 2
    i32.shl
    i32.add
    f32.load
    local.set $11
    local.get $0
    local.get $10
    local.get $17
    i32.mul
    i32.add
    local.get $12
    i32.const 2
    i32.shl
    i32.add
    local.set $10
    i32.const 0
    local.set $12
    loop $while-continue|1
     local.get $7
     local.get $9
     i32.gt_u
     local.get $5
     local.get $12
     i32.gt_u
     i32.and
     if
      local.get $15
      i32.eqz
      local.get $12
      i32.const 8
      i32.add
      local.get $5
      i32.le_u
      i32.and
      if
       local.get $5
       local.get $12
       i32.sub
       i32.const 3
       i32.shr_u
       local.tee $13
       local.get $7
       local.get $9
       i32.sub
       local.tee $18
       local.get $13
       local.get $18
       i32.lt_u
       select
       local.set $18
       i32.const 0
       local.set $13
       loop $for-loop|2
        local.get $13
        local.get $18
        i32.lt_u
        if
         local.get $8
         local.get $9
         i32.add
         i32.const 128
         i32.const 0
         local.get $10
         i32.load8_u
         f32.convert_i32_u
         local.get $11
         f32.ge
         select
         local.tee $19
         i32.const 64
         i32.or
         local.get $19
         local.get $10
         i32.load8_u offset=4
         f32.convert_i32_u
         local.get $11
         f32.ge
         select
         local.tee $19
         i32.const 32
         i32.or
         local.get $19
         local.get $10
         i32.load8_u offset=8
         f32.convert_i32_u
         local.get $11
         f32.ge
         select
         local.tee $19
         i32.const 16
         i32.or
         local.get $19
         local.get $10
         i32.load8_u offset=12
         f32.convert_i32_u
         local.get $11
         f32.ge
         select
         local.tee $19
         i32.const 8
         i32.or
         local.get $19
         local.get $10
         i32.load8_u offset=16
         f32.convert_i32_u
         local.get $11
         f32.ge
         select
         local.tee $19
         i32.const 4
         i32.or
         local.get $19
         local.get $10
         i32.load8_u offset=20
         f32.convert_i32_u
         local.get $11
         f32.ge
         select
         local.tee $19
         i32.const 2
         i32.or
         local.get $19
         local.get $10
         i32.load8_u offset=24
         f32.convert_i32_u
         local.get $11
         f32.ge
         select
         local.tee $19
         i32.const 1
         i32.or
         local.get $19
         local.get $10
         i32.load8_u offset=28
         f32.convert_i32_u
         local.get $11
         f32.ge
         select
         i32.store8
         local.get $9
         i32.const 1
         i32.add
         local.set $9
         local.get $10
         i32.const 32
         i32.add
         local.set $10
         local.get $13
         i32.const 1
         i32.add
         local.set $13
         br $for-loop|2
        end
       end
       local.get $12
       local.get $18
       i32.const 3
       i32.shl
       i32.add
       local.set $12
       br $while-continue|1
      end
      local.get $16
      i32.const 1
      i32.shl
      local.get $11
      local.get $10
      i32.load8_u
      f32.convert_i32_u
      f32.le
      i32.or
      local.set $16
      local.get $10
      i32.const 4
      i32.add
      local.set $10
      local.get $12
      i32.const 1
      i32.add
      local.set $12
      local.get $15
      i32.const 1
      i32.add
      local.tee $15
      i32.const 8
      i32.ge_u
      if
       local.get $8
       local.get $9
       i32.add
       local.get $16
       i32.store8
       i32.const 0
       local.set $16
       i32.const 0
       local.set $15
       local.get $9
       i32.const 1
       i32.add
       local.set $9
      end
      br $while-continue|1
     end
    end
    local.get $14
    i32.const 1
    i32.add
    local.set $14
    br $for-loop|0
   end
  end
  local.get $9
 )
 (func $wasm/hdmi-uvc/src/index/unsharpenLuma1RowWasm (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 f64) (param $5 f64) (param $6 f64)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 f64)
  (local $11 f64)
  (local $12 f64)
  (local $13 f64)
  (local $14 i32)
  (local $15 i32)
  (local $16 f64)
  (local $17 f64)
  (local $18 i32)
  (local $19 i32)
  local.get $4
  f64.const -0.5
  f64.mul
  local.set $11
  local.get $4
  f64.const 1
  f64.add
  local.set $10
  local.get $4
  f64.const 0.5
  f64.mul
  f64.const 1
  f64.add
  local.set $13
  loop $while-continue|0
   local.get $3
   local.get $9
   i32.gt_u
   if
    local.get $0
    local.get $9
    i32.const 2
    i32.shl
    i32.add
    f32.load
    f64.promote_f32
    local.tee $4
    local.get $6
    f64.ge
    local.get $4
    local.get $5
    f64.le
    i32.or
    if
     local.get $9
     i32.const 1
     i32.add
     local.set $9
     br $while-continue|0
    end
    local.get $9
    local.set $7
    loop $while-continue|1
     local.get $7
     i32.const 1
     i32.add
     local.tee $8
     local.get $3
     i32.lt_u
     if
      local.get $0
      local.get $8
      i32.const 2
      i32.shl
      i32.add
      f32.load
      f64.promote_f32
      local.tee $4
      local.get $5
      f64.gt
      local.get $4
      local.get $6
      f64.lt
      i32.and
      if
       local.get $8
       local.set $7
       br $while-continue|1
      end
     end
    end
    local.get $9
    i32.const 0
    i32.ne
    local.set $8
    local.get $7
    local.get $3
    i32.const 1
    i32.sub
    i32.lt_u
    local.set $15
    local.get $7
    local.get $9
    i32.sub
    i32.const 1
    i32.add
    local.tee $14
    i32.const 1
    i32.eq
    if
     local.get $10
     local.set $4
     local.get $0
     local.get $9
     i32.const 2
     i32.shl
     i32.add
     f32.load
     f64.promote_f32
     local.set $12
     local.get $8
     if
      local.get $12
      local.get $11
      local.get $0
      local.get $9
      i32.const 1
      i32.sub
      i32.const 2
      i32.shl
      i32.add
      f32.load
      f64.promote_f32
      f64.mul
      f64.sub
      local.set $12
     else
      local.get $4
      local.get $11
      f64.add
      local.set $4
     end
     local.get $15
     if
      local.get $12
      local.get $11
      local.get $0
      local.get $7
      i32.const 1
      i32.add
      i32.const 2
      i32.shl
      i32.add
      f32.load
      f64.promote_f32
      f64.mul
      f64.sub
      local.set $12
     else
      local.get $4
      local.get $11
      f64.add
      local.set $4
     end
     local.get $0
     local.get $9
     i32.const 2
     i32.shl
     i32.add
     local.get $12
     local.get $4
     f64.div
     f32.demote_f64
     f32.store
     local.get $7
     i32.const 1
     i32.add
     local.set $9
     br $while-continue|0
    end
    local.get $14
    i32.const 2
    i32.eq
    if
     local.get $10
     local.get $13
     local.get $8
     select
     local.set $4
     local.get $10
     local.get $13
     local.get $15
     select
     local.set $12
     local.get $0
     local.get $9
     i32.const 2
     i32.shl
     i32.add
     local.tee $14
     f32.load
     f64.promote_f32
     local.get $8
     if (result f64)
      local.get $11
      local.get $0
      local.get $9
      i32.const 1
      i32.sub
      i32.const 2
      i32.shl
      i32.add
      f32.load
      f64.promote_f32
      f64.mul
     else
      f64.const 0
     end
     f64.sub
     local.tee $16
     local.get $12
     f64.mul
     local.set $17
     local.get $14
     local.get $17
     local.get $11
     local.get $0
     local.get $7
     i32.const 2
     i32.shl
     i32.add
     f32.load
     f64.promote_f32
     local.get $15
     if (result f64)
      local.get $11
      local.get $0
      local.get $7
      i32.const 1
      i32.add
      i32.const 2
      i32.shl
      i32.add
      f32.load
      f64.promote_f32
      f64.mul
     else
      f64.const 0
     end
     f64.sub
     local.tee $17
     f64.mul
     f64.sub
     f64.const 1
     local.get $4
     local.get $12
     f64.mul
     local.get $11
     local.get $11
     f64.mul
     f64.sub
     f64.div
     local.tee $12
     f64.mul
     f32.demote_f64
     f32.store
     local.get $0
     local.get $7
     i32.const 2
     i32.shl
     i32.add
     local.get $4
     local.get $17
     f64.mul
     local.get $11
     local.get $16
     f64.mul
     f64.sub
     local.get $12
     f64.mul
     f32.demote_f64
     f32.store
     local.get $7
     i32.const 1
     i32.add
     local.set $9
     br $while-continue|0
    end
    local.get $10
    local.get $13
    local.get $8
    select
    local.set $4
    local.get $0
    local.get $9
    i32.const 2
    i32.shl
    i32.add
    f32.load
    f64.promote_f32
    local.set $12
    local.get $8
    if (result f64)
     local.get $11
     local.get $0
     local.get $9
     i32.const 1
     i32.sub
     i32.const 2
     i32.shl
     i32.add
     f32.load
     f64.promote_f32
     f64.mul
    else
     f64.const 0
    end
    local.set $16
    local.get $1
    local.get $11
    local.get $4
    f64.div
    f32.demote_f64
    f32.store
    local.get $2
    local.get $12
    local.get $16
    f64.sub
    local.get $4
    f64.div
    f32.demote_f64
    f32.store
    i32.const 1
    local.set $8
    loop $for-loop|2
     local.get $8
     local.get $14
     i32.lt_u
     if
      local.get $10
      local.get $13
      local.get $15
      select
      local.get $10
      local.get $8
      local.get $14
      i32.const 1
      i32.sub
      i32.eq
      local.tee $18
      select
      local.set $12
      local.get $0
      local.get $8
      local.get $9
      i32.add
      i32.const 2
      i32.shl
      i32.add
      f32.load
      f64.promote_f32
      local.set $4
      local.get $15
      local.get $18
      i32.and
      if
       local.get $4
       local.get $11
       local.get $0
       local.get $7
       i32.const 1
       i32.add
       i32.const 2
       i32.shl
       i32.add
       f32.load
       f64.promote_f32
       f64.mul
       f64.sub
       local.set $4
      end
      local.get $1
      local.get $8
      i32.const 2
      i32.shl
      local.tee $19
      i32.add
      f64.const 0
      local.get $11
      local.get $18
      select
      local.get $12
      local.get $11
      local.get $1
      local.get $8
      i32.const 1
      i32.sub
      i32.const 2
      i32.shl
      local.tee $18
      i32.add
      f32.load
      f64.promote_f32
      f64.mul
      f64.sub
      local.tee $12
      f64.div
      f32.demote_f64
      f32.store
      local.get $2
      local.get $19
      i32.add
      local.get $4
      local.get $11
      local.get $2
      local.get $18
      i32.add
      f32.load
      f64.promote_f32
      f64.mul
      f64.sub
      local.get $12
      f64.div
      f32.demote_f64
      f32.store
      local.get $8
      i32.const 1
      i32.add
      local.set $8
      br $for-loop|2
     end
    end
    local.get $0
    local.get $7
    i32.const 2
    i32.shl
    i32.add
    local.get $2
    local.get $14
    i32.const 1
    i32.sub
    i32.const 2
    i32.shl
    i32.add
    f32.load
    f32.store
    local.get $14
    i32.const 2
    i32.sub
    local.set $8
    loop $for-loop|3
     local.get $8
     i32.const 0
     i32.ge_s
     if
      local.get $0
      local.get $8
      local.get $9
      i32.add
      local.tee $14
      i32.const 2
      i32.shl
      i32.add
      local.get $8
      i32.const 2
      i32.shl
      local.tee $15
      local.get $2
      i32.add
      f32.load
      f64.promote_f32
      local.get $1
      local.get $15
      i32.add
      f32.load
      f64.promote_f32
      local.get $0
      local.get $14
      i32.const 1
      i32.add
      i32.const 2
      i32.shl
      i32.add
      f32.load
      f64.promote_f32
      f64.mul
      f64.sub
      f32.demote_f64
      f32.store
      local.get $8
      i32.const 1
      i32.sub
      local.set $8
      br $for-loop|3
     end
    end
    local.get $7
    i32.const 1
    i32.add
    local.set $9
    br $while-continue|0
   end
  end
 )
 (func $wasm/hdmi-uvc/src/index/readLuma1Payload (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32) (param $6 i32) (param $7 i32) (param $8 i32) (param $9 f64) (param $10 i32) (param $11 i32) (result i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 f64)
  (local $19 f64)
  (local $20 f64)
  (local $21 i32)
  (local $22 i32)
  (local $23 i32)
  (local $24 i32)
  (local $25 i32)
  (local $26 f64)
  (local $27 f64)
  (local $28 i32)
  (local $29 i32)
  local.get $1
  i32.const 2
  i32.shl
  local.set $23
  local.get $8
  i32.const 2
  i32.shl
  local.set $21
  local.get $10
  local.tee $13
  local.get $5
  i32.const 2
  i32.shl
  i32.add
  local.set $24
  local.get $10
  local.get $5
  i32.const 3
  i32.shl
  i32.add
  local.set $25
  loop $for-loop|0
   local.get $7
   local.get $16
   i32.gt_u
   local.get $6
   local.get $22
   i32.gt_u
   i32.and
   if
    local.get $3
    local.get $22
    i32.const 3
    i32.shl
    i32.add
    local.tee $10
    i32.load
    local.tee $14
    local.get $10
    i32.load offset=4
    local.tee $10
    i32.or
    i32.const 0
    i32.lt_s
    if
     i32.const 0
     return
    end
    local.get $2
    local.get $10
    i32.le_u
    if
     i32.const 0
     return
    end
    local.get $14
    local.get $5
    i32.const 1
    i32.sub
    local.get $8
    i32.mul
    i32.add
    local.get $1
    i32.ge_u
    if
     i32.const 0
     return
    end
    local.get $4
    local.get $22
    i32.const 40
    i32.mul
    i32.add
    local.tee $15
    f64.load
    local.set $18
    local.get $15
    f64.load offset=8
    local.set $19
    local.get $15
    f64.load offset=16
    local.set $20
    local.get $15
    f64.load offset=24
    local.set $27
    local.get $15
    f64.load offset=32
    local.set $26
    local.get $0
    local.get $10
    local.get $23
    i32.mul
    i32.add
    local.get $14
    i32.const 2
    i32.shl
    i32.add
    local.set $10
    block $for-continue|0
     local.get $9
     f64.const 0
     f64.gt
     if
      i32.const 0
      local.set $14
      loop $for-loop|1
       local.get $5
       local.get $14
       i32.gt_u
       if
        local.get $13
        local.get $14
        i32.const 2
        i32.shl
        i32.add
        local.get $10
        i32.load8_u
        f32.convert_i32_u
        f32.store
        local.get $14
        i32.const 1
        i32.add
        local.set $14
        local.get $10
        local.get $21
        i32.add
        local.set $10
        br $for-loop|1
       end
      end
      local.get $13
      local.get $24
      local.get $25
      local.get $5
      local.get $9
      local.get $27
      local.get $26
      call $wasm/hdmi-uvc/src/index/unsharpenLuma1RowWasm
      i32.const 0
      local.set $10
      loop $while-continue|2
       local.get $7
       local.get $16
       i32.gt_u
       local.get $5
       local.get $10
       i32.gt_u
       i32.and
       if
        local.get $17
        i32.eqz
        local.get $10
        i32.const 4
        i32.add
        local.get $5
        i32.le_u
        i32.and
        if
         local.get $5
         local.get $10
         i32.sub
         i32.const 2
         i32.shr_u
         local.tee $14
         local.get $7
         local.get $16
         i32.sub
         local.tee $15
         local.get $14
         local.get $15
         i32.lt_u
         select
         local.set $15
         i32.const 0
         local.set $14
         loop $for-loop|3
          local.get $14
          local.get $15
          i32.lt_u
          if
           local.get $11
           local.get $16
           i32.add
           block $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$12 (result f64)
            f64.const 0
            local.get $13
            local.get $10
            i32.const 2
            i32.shl
            i32.add
            f32.load
            f64.promote_f32
            local.tee $26
            f64.const 0
            f64.le
            br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$12
            drop
            f64.const 255
            local.get $26
            f64.const 255
            f64.ge
            br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$12
            drop
            local.get $26
            f64.const 0.5
            f64.add
            i32.trunc_sat_f64_s
            f64.convert_i32_s
           end
           local.tee $26
           local.get $18
           f64.le
           if (result i32)
            i32.const 0
           else
            i32.const 1
            i32.const 2
            i32.const 3
            local.get $20
            local.get $26
            f64.ge
            select
            local.get $19
            local.get $26
            f64.ge
            select
           end
           local.tee $28
           i32.const 1
           i32.shr_u
           local.get $28
           i32.xor
           i32.const 6
           i32.shl
           block $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$14 (result f64)
            f64.const 0
            local.get $13
            local.get $10
            i32.const 1
            i32.add
            i32.const 2
            i32.shl
            i32.add
            f32.load
            f64.promote_f32
            local.tee $26
            f64.const 0
            f64.le
            br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$14
            drop
            f64.const 255
            local.get $26
            f64.const 255
            f64.ge
            br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$14
            drop
            local.get $26
            f64.const 0.5
            f64.add
            i32.trunc_sat_f64_s
            f64.convert_i32_s
           end
           local.tee $26
           local.get $18
           f64.le
           if (result i32)
            i32.const 0
           else
            i32.const 1
            i32.const 2
            i32.const 3
            local.get $20
            local.get $26
            f64.ge
            select
            local.get $19
            local.get $26
            f64.ge
            select
           end
           local.tee $28
           i32.const 1
           i32.shr_u
           local.get $28
           i32.xor
           i32.const 4
           i32.shl
           i32.or
           block $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$16 (result f64)
            f64.const 0
            local.get $13
            local.get $10
            i32.const 2
            i32.add
            i32.const 2
            i32.shl
            i32.add
            f32.load
            f64.promote_f32
            local.tee $26
            f64.const 0
            f64.le
            br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$16
            drop
            f64.const 255
            local.get $26
            f64.const 255
            f64.ge
            br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$16
            drop
            local.get $26
            f64.const 0.5
            f64.add
            i32.trunc_sat_f64_s
            f64.convert_i32_s
           end
           local.tee $26
           local.get $18
           f64.le
           if (result i32)
            i32.const 0
           else
            i32.const 1
            i32.const 2
            i32.const 3
            local.get $20
            local.get $26
            f64.ge
            select
            local.get $19
            local.get $26
            f64.ge
            select
           end
           local.tee $28
           i32.const 1
           i32.shr_u
           local.get $28
           i32.xor
           i32.const 2
           i32.shl
           i32.or
           block $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$18 (result f64)
            f64.const 0
            local.get $13
            local.get $10
            i32.const 3
            i32.add
            i32.const 2
            i32.shl
            i32.add
            f32.load
            f64.promote_f32
            local.tee $26
            f64.const 0
            f64.le
            br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$18
            drop
            f64.const 255
            local.get $26
            f64.const 255
            f64.ge
            br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$18
            drop
            local.get $26
            f64.const 0.5
            f64.add
            i32.trunc_sat_f64_s
            f64.convert_i32_s
           end
           local.tee $26
           local.get $18
           f64.le
           if (result i32)
            i32.const 0
           else
            i32.const 1
            i32.const 2
            i32.const 3
            local.get $20
            local.get $26
            f64.ge
            select
            local.get $19
            local.get $26
            f64.ge
            select
           end
           local.tee $28
           i32.const 1
           i32.shr_u
           local.get $28
           i32.xor
           i32.or
           i32.store8
           local.get $16
           i32.const 1
           i32.add
           local.set $16
           local.get $10
           i32.const 4
           i32.add
           local.set $10
           local.get $14
           i32.const 1
           i32.add
           local.set $14
           br $for-loop|3
          end
         end
         br $while-continue|2
        end
        local.get $12
        i32.const 2
        i32.shl
        block $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$20 (result f64)
         f64.const 0
         local.get $13
         local.get $10
         i32.const 2
         i32.shl
         i32.add
         f32.load
         f64.promote_f32
         local.tee $26
         f64.const 0
         f64.le
         br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$20
         drop
         f64.const 255
         local.get $26
         f64.const 255
         f64.ge
         br_if $__inlined_func$wasm/hdmi-uvc/src/index/luma1RoundSample$20
         drop
         local.get $26
         f64.const 0.5
         f64.add
         i32.trunc_sat_f64_s
         f64.convert_i32_s
        end
        local.tee $26
        local.get $18
        f64.le
        if (result i32)
         i32.const 0
        else
         i32.const 1
         i32.const 2
         i32.const 3
         local.get $20
         local.get $26
         f64.ge
         select
         local.get $19
         local.get $26
         f64.ge
         select
        end
        local.tee $12
        i32.const 1
        i32.shr_u
        local.get $12
        i32.xor
        i32.or
        local.set $12
        local.get $10
        i32.const 1
        i32.add
        local.set $10
        local.get $17
        i32.const 2
        i32.add
        local.tee $17
        i32.const 8
        i32.ge_u
        if
         local.get $11
         local.get $16
         i32.add
         local.get $12
         local.get $17
         i32.const 8
         i32.sub
         local.tee $17
         i32.shr_u
         i32.store8
         local.get $16
         i32.const 1
         i32.add
         local.set $16
         local.get $17
         if (result i32)
          local.get $12
          i32.const 1
          local.get $17
          i32.shl
          i32.const 1
          i32.sub
          i32.and
         else
          i32.const 0
         end
         local.set $12
        end
        br $while-continue|2
       end
      end
      br $for-continue|0
     end
     i32.const 0
     local.set $14
     loop $while-continue|4
      local.get $7
      local.get $16
      i32.gt_u
      local.get $5
      local.get $14
      i32.gt_u
      i32.and
      if
       local.get $17
       i32.eqz
       local.get $14
       i32.const 4
       i32.add
       local.get $5
       i32.le_u
       i32.and
       if
        local.get $5
        local.get $14
        i32.sub
        i32.const 2
        i32.shr_u
        local.tee $15
        local.get $7
        local.get $16
        i32.sub
        local.tee $28
        local.get $15
        local.get $28
        i32.lt_u
        select
        local.set $28
        i32.const 0
        local.set $15
        loop $for-loop|5
         local.get $15
         local.get $28
         i32.lt_u
         if
          local.get $11
          local.get $16
          i32.add
          local.get $10
          i32.load8_u
          f64.convert_i32_u
          local.tee $26
          local.get $18
          f64.le
          if (result i32)
           i32.const 0
          else
           i32.const 1
           i32.const 2
           i32.const 3
           local.get $20
           local.get $26
           f64.ge
           select
           local.get $19
           local.get $26
           f64.ge
           select
          end
          local.tee $29
          i32.const 1
          i32.shr_u
          local.get $29
          i32.xor
          i32.const 6
          i32.shl
          local.get $10
          local.get $21
          i32.add
          i32.load8_u
          f64.convert_i32_u
          local.tee $26
          local.get $18
          f64.le
          if (result i32)
           i32.const 0
          else
           i32.const 1
           i32.const 2
           i32.const 3
           local.get $20
           local.get $26
           f64.ge
           select
           local.get $19
           local.get $26
           f64.ge
           select
          end
          local.tee $29
          i32.const 1
          i32.shr_u
          local.get $29
          i32.xor
          i32.const 4
          i32.shl
          i32.or
          local.get $10
          local.get $21
          i32.const 1
          i32.shl
          i32.add
          i32.load8_u
          f64.convert_i32_u
          local.tee $26
          local.get $18
          f64.le
          if (result i32)
           i32.const 0
          else
           i32.const 1
           i32.const 2
           i32.const 3
           local.get $20
           local.get $26
           f64.ge
           select
           local.get $19
           local.get $26
           f64.ge
           select
          end
          local.tee $29
          i32.const 1
          i32.shr_u
          local.get $29
          i32.xor
          i32.const 2
          i32.shl
          i32.or
          local.get $10
          local.get $21
          i32.const 3
          i32.mul
          i32.add
          i32.load8_u
          f64.convert_i32_u
          local.tee $26
          local.get $18
          f64.le
          if (result i32)
           i32.const 0
          else
           i32.const 1
           i32.const 2
           i32.const 3
           local.get $20
           local.get $26
           f64.ge
           select
           local.get $19
           local.get $26
           f64.ge
           select
          end
          local.tee $29
          i32.const 1
          i32.shr_u
          local.get $29
          i32.xor
          i32.or
          i32.store8
          local.get $16
          i32.const 1
          i32.add
          local.set $16
          local.get $10
          local.get $21
          i32.const 2
          i32.shl
          i32.add
          local.set $10
          local.get $15
          i32.const 1
          i32.add
          local.set $15
          br $for-loop|5
         end
        end
        local.get $14
        local.get $28
        i32.const 2
        i32.shl
        i32.add
        local.set $14
        br $while-continue|4
       end
       local.get $12
       i32.const 2
       i32.shl
       local.get $10
       i32.load8_u
       f64.convert_i32_u
       local.tee $26
       local.get $18
       f64.le
       if (result i32)
        i32.const 0
       else
        i32.const 1
        i32.const 2
        i32.const 3
        local.get $20
        local.get $26
        f64.ge
        select
        local.get $19
        local.get $26
        f64.ge
        select
       end
       local.tee $12
       i32.const 1
       i32.shr_u
       local.get $12
       i32.xor
       i32.or
       local.set $12
       local.get $10
       local.get $21
       i32.add
       local.set $10
       local.get $14
       i32.const 1
       i32.add
       local.set $14
       local.get $17
       i32.const 2
       i32.add
       local.tee $17
       i32.const 8
       i32.ge_u
       if
        local.get $11
        local.get $16
        i32.add
        local.get $12
        local.get $17
        i32.const 8
        i32.sub
        local.tee $17
        i32.shr_u
        i32.store8
        local.get $16
        i32.const 1
        i32.add
        local.set $16
        local.get $17
        if (result i32)
         local.get $12
         i32.const 1
         local.get $17
         i32.shl
         i32.const 1
         i32.sub
         i32.and
        else
         i32.const 0
        end
        local.set $12
       end
       br $while-continue|4
      end
     end
    end
    local.get $22
    i32.const 1
    i32.add
    local.set $22
    br $for-loop|0
   end
  end
  local.get $16
 )
 (func $wasm/hdmi-uvc/src/index/probeExpectedPackets (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32) (param $6 i32) (param $7 i32) (result i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  local.get $2
  i32.const 15
  i32.le_u
  if
   i32.const 0
   return
  end
  local.get $1
  local.get $2
  i32.lt_u
  if
   i32.const 0
   return
  end
  local.get $1
  local.get $2
  i32.rem_u
  if
   i32.const 0
   return
  end
  local.get $1
  local.get $2
  i32.div_u
  local.tee $1
  local.get $7
  i32.le_u
  if
   local.get $1
   local.set $7
  end
  local.get $2
  i32.const 15
  i32.sub
  local.set $1
  local.get $5
  i32.const 1
  i32.and
  local.set $9
  local.get $5
  i32.const 2
  i32.and
  i32.const 0
  i32.ne
  local.set $10
  i32.const 0
  local.set $5
  loop $for-loop|0
   local.get $5
   local.get $7
   i32.lt_u
   if
    block $for-continue|0
     local.get $0
     local.get $2
     local.get $5
     i32.mul
     i32.add
     local.tee $16
     i32.load8_u
     local.tee $11
     i32.const 3
     i32.shr_u
     i32.const 1
     i32.ne
     br_if $for-continue|0
     local.get $16
     i32.const 1
     i32.add
     i32.load8_u offset=3
     local.get $16
     i32.load8_u offset=1
     i32.const 24
     i32.shl
     local.get $16
     i32.load8_u offset=2
     i32.const 16
     i32.shl
     i32.or
     local.get $16
     i32.load8_u offset=3
     i32.const 8
     i32.shl
     i32.or
     i32.or
     local.tee $12
     local.get $3
     i32.ne
     local.get $9
     i32.and
     br_if $for-continue|0
     local.get $16
     i32.const 5
     i32.add
     i32.load8_u offset=2
     local.get $16
     i32.load8_u offset=5
     i32.const 16
     i32.shl
     local.get $16
     i32.load8_u offset=6
     i32.const 8
     i32.shl
     i32.or
     i32.or
     local.tee $13
     local.get $4
     i32.ne
     local.get $10
     i32.and
     br_if $for-continue|0
     local.get $16
     i32.const 8
     i32.add
     i32.load8_u offset=2
     local.get $16
     i32.load8_u offset=8
     i32.const 16
     i32.shl
     local.get $16
     i32.load8_u offset=9
     i32.const 8
     i32.shl
     i32.or
     i32.or
     local.set $14
     local.get $16
     i32.const 11
     i32.add
     i32.load8_u offset=3
     local.get $16
     i32.load8_u offset=11
     i32.const 24
     i32.shl
     local.get $16
     i32.load8_u offset=12
     i32.const 16
     i32.shl
     i32.or
     local.get $16
     i32.load8_u offset=13
     i32.const 8
     i32.shl
     i32.or
     i32.or
     local.set $15
     local.get $16
     i32.const 15
     i32.add
     local.get $1
     call $wasm/hdmi-uvc/src/index/crc32
     local.get $15
     i32.ne
     br_if $for-continue|0
     local.get $6
     local.get $8
     i32.const 24
     i32.mul
     i32.add
     local.tee $16
     local.get $5
     i32.store
     local.get $16
     local.get $12
     i32.store offset=4
     local.get $16
     local.get $13
     i32.store offset=8
     local.get $16
     local.get $14
     i32.store offset=12
     local.get $16
     local.get $11
     i32.store offset=16
     local.get $16
     local.get $15
     i32.store offset=20
     local.get $8
     i32.const 1
     i32.add
     local.set $8
    end
    local.get $5
    i32.const 1
    i32.add
    local.set $5
    br $for-loop|0
   end
  end
  local.get $8
 )
 (func $wasm/hdmi-uvc/src/index/scanBrightRuns (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32) (param $6 i32) (param $7 i32) (param $8 i32) (param $9 i32) (param $10 i32) (param $11 i32) (param $12 i32) (result i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  local.get $7
  i32.eqz
  if
   i32.const 0
   return
  end
  local.get $3
  local.get $4
  i32.ge_u
  if
   i32.const 0
   return
  end
  local.get $1
  local.get $4
  i32.lt_u
  if
   i32.const 0
   return
  end
  local.get $5
  local.set $14
  loop $while-continue|0
   local.get $6
   local.get $14
   i32.ne
   if
    local.get $14
    i32.const 0
    i32.lt_s
    if
     local.get $7
     local.get $14
     i32.add
     local.set $14
     br $while-continue|0
    end
    local.get $2
    local.get $14
    i32.le_u
    if
     local.get $7
     local.get $14
     i32.add
     local.set $14
     br $while-continue|0
    end
    local.get $1
    local.get $14
    i32.mul
    i32.const 2
    i32.shl
    local.set $18
    i32.const -1
    local.set $16
    i32.const 0
    local.set $15
    local.get $3
    local.set $5
    loop $for-loop|1
     local.get $4
     local.get $5
     i32.gt_u
     if
      local.get $0
      local.get $18
      i32.add
      local.get $5
      i32.const 2
      i32.shl
      i32.add
      i32.load8_u
      local.get $10
      i32.gt_u
      if (result i32)
       local.get $15
       i32.const 1
       i32.add
       local.set $15
       local.get $5
       local.get $16
       local.get $16
       i32.const 0
       i32.lt_s
       select
      else
       local.get $8
       local.get $15
       i32.le_u
       local.get $9
       local.get $15
       i32.ge_u
       i32.and
       if
        local.get $12
        local.get $13
        i32.le_u
        if
         local.get $13
         return
        end
        local.get $11
        local.get $13
        i32.const 12
        i32.mul
        i32.add
        local.tee $17
        local.get $16
        i32.store
        local.get $17
        local.get $14
        i32.store offset=4
        local.get $17
        local.get $15
        i32.store offset=8
        local.get $13
        i32.const 1
        i32.add
        local.set $13
       end
       i32.const 0
       local.set $15
       i32.const -1
      end
      local.set $16
      local.get $5
      i32.const 1
      i32.add
      local.set $5
      br $for-loop|1
     end
    end
    local.get $8
    local.get $15
    i32.le_u
    local.get $9
    local.get $15
    i32.ge_u
    i32.and
    if
     local.get $12
     local.get $13
     i32.le_u
     if
      local.get $13
      return
     end
     local.get $11
     local.get $13
     i32.const 12
     i32.mul
     i32.add
     local.tee $5
     local.get $16
     i32.store
     local.get $5
     local.get $14
     i32.store offset=4
     local.get $5
     local.get $15
     i32.store offset=8
     local.get $13
     i32.const 1
     i32.add
     local.set $13
    end
    local.get $7
    local.get $14
    i32.add
    local.set $14
    br $while-continue|0
   end
  end
  local.get $13
 )
)
