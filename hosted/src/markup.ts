import { Liquid, type Template } from "liquidjs";

import fullTemplate from "../../src/full.liquid";
import halfHorizontalTemplate from "../../src/half_horizontal.liquid";
import halfVerticalTemplate from "../../src/half_vertical.liquid";
import quadrantTemplate from "../../src/quadrant.liquid";
import sharedTemplate from "../../src/shared.liquid";

export interface ScreenMarkup {
  markup: string;
  markup_half_horizontal: string;
  markup_half_vertical: string;
  markup_quadrant: string;
}

interface LayoutTemplate {
  className: string;
  template: Template[];
}

const TEMPLATE_BLOCK =
  /{%\s*template\s+([A-Za-z_][A-Za-z0-9_-]*)\s*%}([\s\S]*?){%\s*endtemplate\s*%}/g;

function extractSharedTemplates(source: string): Record<string, string> {
  const templates: Record<string, string> = {};

  for (const match of source.matchAll(TEMPLATE_BLOCK)) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) {
      continue;
    }
    if (Object.hasOwn(templates, name)) {
      throw new Error(`Duplicate shared Liquid template: ${name}`);
    }
    templates[name] = body;
  }

  if (Object.keys(templates).length === 0) {
    throw new Error("No shared Liquid templates were found");
  }

  return templates;
}

const engine = new Liquid({
  cache: true,
  templates: extractSharedTemplates(sharedTemplate),
});

const layouts = {
  markup: {
    className: "full",
    template: engine.parse(fullTemplate),
  },
  markup_half_horizontal: {
    className: "half_horizontal",
    template: engine.parse(halfHorizontalTemplate),
  },
  markup_half_vertical: {
    className: "half_vertical",
    template: engine.parse(halfVerticalTemplate),
  },
  markup_quadrant: {
    className: "quadrant",
    template: engine.parse(quadrantTemplate),
  },
} as const satisfies Record<keyof ScreenMarkup, LayoutTemplate>;

async function renderLayout(
  layout: LayoutTemplate,
  variables: Record<string, unknown>,
): Promise<string> {
  const body = await engine.render(layout.template, variables);
  return `<div class="view view--${layout.className}">\n${body}\n</div>`;
}

export async function renderScreenMarkup(
  variables: Record<string, unknown>,
): Promise<ScreenMarkup> {
  const [markup, markupHalfHorizontal, markupHalfVertical, markupQuadrant] =
    await Promise.all([
      renderLayout(layouts.markup, variables),
      renderLayout(layouts.markup_half_horizontal, variables),
      renderLayout(layouts.markup_half_vertical, variables),
      renderLayout(layouts.markup_quadrant, variables),
    ]);

  return {
    markup,
    markup_half_horizontal: markupHalfHorizontal,
    markup_half_vertical: markupHalfVertical,
    markup_quadrant: markupQuadrant,
  };
}
