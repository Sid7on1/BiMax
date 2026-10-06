import pathlib, subprocess
stage=pathlib.Path('/tmp/bimax-fresh-chat-20261005/mac-arm64/Bimax.app')
identity='Bimax Local Code Signing'
for target in [stage/'Contents/Resources/voice/bimax-voice',stage/'Contents/Resources/notch/bimax-notch',stage/'Contents/Extensions/BimaxIntents.appex',stage]:
 args=['codesign','--force','--sign',identity,'--timestamp=none']
 if target==stage: args+=['--entitlements','app/buildResources/entitlements.mac.local.plist']
 subprocess.run(args+[str(target)],check=True)
subprocess.run(['codesign','--verify','--deep','--strict','--verbose=2',str(stage)],check=True)
subprocess.run(['codesign','--display','--requirements','-',str(stage)],check=True)
print('Signed current helpers/extension/app; retained unchanged signed Electron 43.3.0 runtime.')
