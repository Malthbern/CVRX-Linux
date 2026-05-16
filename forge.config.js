const { version } = require('./package.json');

module.exports = {
    packagerConfig: {
        icon: 'icon/cvrx-logo',
        // Force the inner binary filename to match package.json `name` (lowercase).
        // maker-deb / maker-rpm derive the expected binary filename from `name`
        // and fail if the packager produced one cased after `productName` instead.
        // Affects only the binary filename inside the package — the Windows
        // installer, .app bundle, and shortcut names still use productName.
        executableName: 'cvrx',
    },
    rebuildConfig: {},
    makers: [
        {
            name: '@electron-forge/maker-squirrel',
            config: {
                name: 'CVRX',
                authors: 'CVRX',
                description: 'CVRX Desktop App',
                // URL to an ICO file to use as the application icon (displayed in Control Panel > Programs and Features).
                iconUrl: 'https://raw.githubusercontent.com/AstroDogeDX/CVRX/main/icon/cvrx-logo.ico',
                // The ICO file to use as the icon for the generated Setup.exe
                setupIcon: 'icon/cvrx-logo.ico',
                loadingGif: 'icon/loading.gif',
                setupExe: `CVRX-v${version}-Windows.exe`,
            },
        },
        {
            name: '@electron-forge/maker-zip',
            platforms: ['linux'],
        },
        {
            name: '@electron-forge/maker-deb',
            config: {
                options: {
                    maintainer: 'CVRX',
                    homepage: 'https://github.com/AstroDogeDX/CVRX',
                    icon: 'icon/cvrx-logo.png',
                },
            },
        },
        {
            name: '@electron-forge/maker-rpm',
            config: {
                options: {
                    icon: 'icon/cvrx-logo.png',
                    homepage: 'https://github.com/AstroDogeDX/CVRX',
                },
            },
        },
        {
            // Community-maintained AppImage maker — covers distros that don't
            // use deb/rpm (Arch, NixOS, Steam Deck/SteamOS, etc.) plus anyone
            // who prefers a portable single-file binary.
            name: '@reforged/maker-appimage',
            config: {
                options: {
                    icon: 'icon/cvrx-logo.png',
                    categories: ['Network', 'Utility'],
                    // Must match packagerConfig.executableName above.
                    bin: 'cvrx',
                },
            },
        },
        {
            name: '@electron-forge/maker-dmg',
            config: {
                overwrite: true,
                icon: 'icon/cvrx-logo.icns',
                name: `CVRX-v${version}-MacOS`,
            },
        },
    ],
};
