using UnrealBuildTool;

public class GitNexusUnreal : ModuleRules
{
    public GitNexusUnreal(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new[]
        {
            "Core",
            "CoreUObject",
            "Engine"
        });

        PrivateDependencyModuleNames.AddRange(new[]
        {
            "AssetRegistry",
            "BlueprintGraph",
            "Json",
            "JsonUtilities",
            "Kismet",
            "KismetCompiler",
            "Projects",
            "SlateCore",
            "UnrealEd"
        });
    }
}
