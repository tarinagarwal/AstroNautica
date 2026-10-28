import React from "react";
import renderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import { selectStories, buildEffectiveLists } from "@azaadawaaz/core";
import { I18nProvider } from "../i18n";
import { Markdown } from "../components/media";
import { StoryCard } from "../components/story";
import { owner, ownerLists, publishStory } from "../../test/fixtures";

jest.mock("react-native-video", () => "Video");
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const allText = (tree: renderer.ReactTestRenderer) =>
  tree.root
    .findAllByType(Text)
    .map((t) =>
      []
        .concat(t.props.children)
        .filter((c) => typeof c === "string")
        .join(""),
    )
    .join("|");

describe("UI components", () => {
  it("renders Markdown as native text, never as HTML", () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <I18nProvider>
          <Markdown source={"## सुबह\n\nपानी **बढ़ा** <b>x</b>"} lang="hi" />
        </I18nProvider>,
      );
    });
    const text = allText(tree);
    expect(text).toContain("सुबह");
    expect(text).toContain("बढ़ा");
    expect(text).toContain("<b>x</b>");
    const heading = tree.root.findAllByType(Text).find((t) => t.props.accessibilityRole === "header")!;
    expect(heading.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ fontFamily: "NotoSansDevanagari" })]),
    );
  });

  it("shows a story card with its title and tags", () => {
    const story = publishStory();
    const ref = selectStories([story.event], buildEffectiveLists(owner.pubkey, ownerLists()))[0]!;
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <I18nProvider>
          <StoryCard story={ref} onPress={() => undefined} />
        </I18nProvider>,
      );
    });
    expect(allText(tree)).toContain("Floods in the valley");
  });
});
