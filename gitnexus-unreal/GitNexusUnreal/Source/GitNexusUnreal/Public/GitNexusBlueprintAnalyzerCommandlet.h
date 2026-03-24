#pragma once

#include "Commandlets/Commandlet.h"
#include "GitNexusBlueprintAnalyzerCommandlet.generated.h"

class UBlueprint;
class UEdGraph;
class UEdGraphNode;

UCLASS()
class GITNEXUSUNREAL_API UGitNexusBlueprintAnalyzerCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UGitNexusBlueprintAnalyzerCommandlet();

	virtual int32 Main(const FString& Params) override;

private:
	int32 RunSyncAssets(const FString& OutputJsonPath);
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

	bool WriteJsonToFile(const FString& OutputJsonPath, const TSharedPtr<FJsonObject>& RootObject) const;
	TArray<FString> LoadCandidateAssets(const FString& CandidatesJsonPath) const;
	TArray<FAssetData> GetAllBlueprintAssets() const;
	UBlueprint* LoadBlueprintFromAssetPath(const FString& AssetPath) const;
	void CollectBlueprintGraphs(UBlueprint* Blueprint, TArray<UEdGraph*>& OutGraphs) const;
	bool IsTargetFunctionNode(const UEdGraphNode* Node, const FString& TargetSymbolKey, const FString& TargetClassName, const FString& TargetFunctionName) const;
	TSharedPtr<FJsonObject> BuildReferenceJson(UBlueprint* Blueprint, const UEdGraph* Graph, const UEdGraphNode* Node) const;
	TSharedPtr<FJsonObject> BuildChainNodeJson(const UEdGraph* Graph, const UEdGraphNode* Node, int32 Depth) const;
	UEdGraphNode* FindNodeByGuid(UBlueprint* Blueprint, const FString& NodeGuid) const;
};
