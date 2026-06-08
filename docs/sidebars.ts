import type { SidebarsConfig } from "@docusaurus/plugin-content-docs"

/**
 * Deliberately short. Every page here is one somebody needs and nothing else
 * answers. Feature tours were left out: the app explains itself, and a page
 * per feature is a page per feature to keep true.
 */
const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Overview",
      collapsed: false,
      items: ["overview/introduction", "overview/quick-start"],
    },
    {
      type: "category",
      label: "Install",
      collapsed: false,
      items: ["install/self-hosting", "install/remote-access", "install/push-notifications"],
    },
    "safety",
    "privacy",
    "faq",
    {
      type: "category",
      label: "Developer",
      items: ["developer/architecture", "developer/api", "developer/mobile"],
    },
    "roadmap",
  ],
}

export default sidebars
