#ifndef AppVersion
  #error AppVersion must be provided by the Windows packaging script.
#endif

#define AppName "LitRoot"
#define AppExeName "LitRoot.exe"

[Setup]
AppId=io.litroot.desktop
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\LitRoot
DefaultGroupName=LitRoot
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
OutputDir=..\release
OutputBaseFilename=LitRoot-{#AppVersion}-windows-x64-unsigned-setup
SetupIconFile=..\resources\litroot-app-icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableWelcomePage=no
DisableDirPage=no
LanguageDetectionMethod=uilanguage
ShowLanguageDialog=yes
UsePreviousLanguage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\Unofficial\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\release\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\LitRoot"; Filename: "{app}\{#AppExeName}"
Name: "{userdesktop}\LitRoot"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,LitRoot}"; Flags: nowait postinstall skipifsilent
