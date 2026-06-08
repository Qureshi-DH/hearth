import type * as Preset from "@docusaurus/preset-classic"
import type { Config } from "@docusaurus/types"
import { themes as prismThemes } from "prism-react-renderer"

const config: Config = {
  title: "Hearth",
  tagline: "Family location sharing you host yourself",
  favicon: "img/favicon.ico",

  url: "https://hearth-docs.pages.dev",
  baseUrl: "/",
  organizationName: "Qureshi-DH",
  projectName: "hearth",

  onBrokenLinks: "throw",
  markdown: { hooks: { onBrokenMarkdownLinks: "throw" } },

  i18n: { defaultLocale: "en", locales: ["en"] },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          // Docs are the whole site. There is no separate landing route here,
          // because the marketing page lives in web/ and is deployed apart.
          routeBasePath: "/",
          editUrl: "https://github.com/Qureshi-DH/hearth/tree/main/docs/",
          showLastUpdateTime: true,
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      // Offline search. Algolia would mean a third party watching what
      // self-hosters look up, which is a strange thing to ask of this audience.
      "@easyops-cn/docusaurus-search-local",
      { hashed: true, indexBlog: false, docsRouteBasePath: "/" },
    ],
  ],

  themeConfig: {
    colorMode: { defaultMode: "dark", respectPrefersColorScheme: true },
    navbar: {
      title: "Hearth",
      logo: { alt: "Hearth", src: "img/logo.svg" },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Documentation" },
        { to: "/developer/api", label: "API", position: "left" },
        {
          href: "https://github.com/Qureshi-DH/hearth",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Get started",
          items: [
            { label: "Quick start", to: "/overview/quick-start" },
            { label: "Self-hosting", to: "/install/self-hosting" },
            { label: "Remote access", to: "/install/remote-access" },
          ],
        },
        {
          title: "Understand it",
          items: [
            { label: "Privacy", to: "/privacy" },
            { label: "Architecture", to: "/developer/architecture" },
            { label: "FAQ", to: "/faq" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "GitHub", href: "https://github.com/Qureshi-DH/hearth" },
            {
              label: "Contributing",
              href: "https://github.com/Qureshi-DH/hearth/blob/main/CONTRIBUTING.md",
            },
            { label: "Roadmap", to: "/roadmap" },
          ],
        },
      ],
      copyright: "Hearth is free software under the AGPL-3.0.",
    },
    prism: { theme: prismThemes.github, darkTheme: prismThemes.dracula },
  } satisfies Preset.ThemeConfig,
}

export default config
