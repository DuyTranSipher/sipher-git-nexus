#pragma once

#include "Commandlets/Commandlet.h"
#include "GitNexusBlueprintAnalyzerCommandlet.generated.h"

class UBlueprint;
class UEdGraph;
class UEdGraphNode;
class UEdGraphPin;

UCLASS()
class GITNEXUSUNREAL_API UGitNexusBlueprintAnalyzerCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UGitNexusBlueprintAnalyzerCommandlet();

	virtual int32 Main(const FString& Params) override;

private:
	// ── SyncAssets ────────────────────────────────────────────────────────
	int32 RunSyncAssets(const FString& OutputJsonPath, const FString& FilterJsonPath, bool bDeepMode, const FString& KnownAssetsJsonPath);
	int32 RunSyncAssetsMetadata(const FString& OutputJsonPath, const TArray<FAssetData>& Assets);
	int32 RunSyncAssetsDeep(const FString& OutputJsonPath, const TArray<FAssetData>& Assets, const TMap<FString, FString>& KnownAssets);

	// ── Other operations ─────────────────────────────────────────────────
	int32 RunFindNativeBlueprintReferences(
		const FString& OutputJsonPath,
		const FString& CandidatesJsonPath,
		const FString& TargetSymbolKey,
		const FString& TargetClassName,
		const FString& TargetFunctionName
	);
	int32 RunExpandBlueprintChain(
		const FString& OutputJsonPath,
		const FString& AssetPath,
		const FString& ChainAnchorId,
		const FString& Direction,
		int32 MaxDepth
	);

	// ── Helpers ──────────────────────────────────────────────────────────

	struct FFilterPrefixes
	{
		TArray<FString> IncludePrefixes;
		TArray<FString> ExcludePrefixes;
		/** Glob or regex: patterns for include (whitelist). Evaluated after prefix check. */
		TArray<FString> IncludePatterns;
		/** Glob or regex: patterns for exclude (blacklist). Evaluated after prefix check. */
		TArray<FString> ExcludePatterns;
		/** Extra asset class paths for non-Blueprint discovery (e.g., "/Script/EnhancedInput.InputAction") */
		TArray<FString> ExtraAssetClassPaths;
	};

	bool WriteJsonToFile(const FString& OutputJsonPath, const TSharedPtr<FJsonObject>& RootObject) const;
	TArray<FString> LoadCandidateAssets(const FString& CandidatesJsonPath) const;
	FFilterPrefixes LoadFilterPrefixes(const FString& FilterJsonPath) const;
	TMap<FString, FString> LoadKnownAssets(const FString& KnownAssetsJsonPath) const;
	static FString GetAssetFileModifiedAt(const FAssetData& AssetData);
	TArray<FAssetData> GetAllBlueprintAssets(const FFilterPrefixes& Filters = FFilterPrefixes()) const;
	UBlueprint* LoadBlueprintFromAssetPath(const FString& AssetPath) const;
	void CollectBlueprintGraphs(UBlueprint* Blueprint, TArray<UEdGraph*>& OutGraphs) const;
	bool IsTargetFunctionNode(const UEdGraphNode* Node, const FString& TargetSymbolKey, const FString& TargetClassName, const FString& TargetFunctionName) const;
	TSharedPtr<FJsonObject> BuildReferenceJson(UBlueprint* Blueprint, const UEdGraph* Graph, const UEdGraphNode* Node) const;
	TSharedPtr<FJsonObject> BuildChainNodeJson(
		const UEdGraph* Graph, const UEdGraphNode* Node, int32 Depth,
		const FString& TraversedFromPinName = FString(),
		const FGuid& TraversedFromNodeId = FGuid()) const;
	TSharedPtr<FJsonObject> BuildPinJson(const UEdGraphPin* Pin) const;
	TSharedPtr<FJsonObject> BuildPinsJson(const UEdGraphNode* Node) const;
	void AnnotateNodeMetadata(TSharedPtr<FJsonObject>& NodeObj, const UEdGraphNode* Node) const;
	void AnnotateNodeDetails(TSharedPtr<FJsonObject>& NodeObj, const UEdGraphNode* Node) const;
	UEdGraphNode* FindNodeByGuid(UBlueprint* Blueprint, const FString& NodeGuid) const;
};
